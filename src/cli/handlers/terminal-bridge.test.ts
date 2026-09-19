import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalSummary
} from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import { BRIDGE_HANDLERS } from './terminal-bridge'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test helper creates synthetic RuntimeClient with mock call implementation.
const toMockClient = (call: unknown) => ({ call }) as unknown as RuntimeClient

function fakeTerminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    worktreePath: '/workspaces/proj',
    branch: 'main',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'Terminal 1',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    index: 1,
    target: '@1',
    label: 'Terminal 1',
    ...overrides
  }
}

describe('terminal bridge CLI', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('bridge list prints formatted terminals with target and index', async () => {
    const listResult: RuntimeTerminalListResult = {
      terminals: [
        fakeTerminal({ handle: 'term_1', index: 1, target: '@1', title: 'Shell 1' }),
        fakeTerminal({ handle: 'term_2', index: 2, target: '@2', title: 'Agent Worker' })
      ],
      totalCount: 2,
      truncated: false
    }

    const call = vi.fn().mockResolvedValue({
      id: 'req-list',
      ok: true,
      result: listResult,
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge list']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false
    })

    expect(call).toHaveBeenCalledWith('terminal.list', expect.objectContaining({ limit: 100 }))
    const printed = String(log.mock.calls[0]?.[0] ?? '')
    expect(printed).toContain('TARGET')
    expect(printed).toContain('@1')
    expect(printed).toContain('@2')
    expect(printed).toContain('term_1')
    expect(printed).toContain('term_2')
  })

  it('bridge id returns @index when ORCA_TERMINAL_INDEX is present', async () => {
    process.env.ORCA_TERMINAL_INDEX = '3'
    process.env.ORCA_TERMINAL_HANDLE = 'term_3'

    const call = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge id']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false
    })

    expect(log).toHaveBeenCalledWith('@3')
  })

  it('bridge resolve resolves target @2 into terminal handle', async () => {
    const listResult: RuntimeTerminalListResult = {
      terminals: [
        fakeTerminal({ handle: 'term_1', index: 1, target: '@1' }),
        fakeTerminal({ handle: 'term_2', index: 2, target: '@2' })
      ],
      totalCount: 2,
      truncated: false
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge resolve']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@2']
    })

    expect(log).toHaveBeenCalledWith('term_2')
  })

  it('bridge read arms read-guard and allows subsequent message send', async () => {
    const handle = 'term_guard_test'
    const listResult: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle, index: 1, target: '@1' })],
      totalCount: 1,
      truncated: false
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.read') {
        return Promise.resolve({
          id: '2',
          ok: true,
          result: { terminal: { handle, tail: 'Current buffer line 1\n' } }
        })
      }
      if (method === 'terminal.send') {
        return Promise.resolve({
          id: '3',
          ok: true,
          result: { send: { accepted: true } }
        })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    process.env.ORCA_TERMINAL_INDEX = '1'
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'

    // Step 1: Trying to send message without reading should be blocked by read guard
    await expect(
      BRIDGE_HANDLERS['bridge message']({
        flags: new Map(),
        client: toMockClient(call),
        cwd: '/workspaces/proj',
        json: false,
        rawArgs: ['@1', 'Hello worker']
      })
    ).rejects.toThrow(/must read the terminal before interacting/)

    // Step 2: Read target terminal
    await BRIDGE_HANDLERS['bridge read']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1', '10']
    })

    expect(stdoutWrite).toHaveBeenCalledWith('Current buffer line 1\n')

    // Step 3: Now sending message should succeed and contain [orca-bridge from:@1 ...]
    await BRIDGE_HANDLERS['bridge message']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1', 'Hello worker']
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({
        terminal: handle,
        enter: true,
        text: expect.stringContaining('[orca-bridge from:@1')
      })
    )

    // Step 4: After send, read guard is cleared, so immediate subsequent send without read fails again
    await expect(
      BRIDGE_HANDLERS['bridge message']({
        flags: new Map(),
        client: toMockClient(call),
        cwd: '/workspaces/proj',
        json: false,
        rawArgs: ['@1', 'Second message']
      })
    ).rejects.toThrow(/must read the terminal before interacting/)
  })

  it('bridge read formats code blocks for human reading, supports --raw and --compact', async () => {
    const handle = 'term_human_test'
    const listResult: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle, index: 1, target: '@1' })],
      totalCount: 1,
      truncated: false
    }
    const readResult: RuntimeTerminalRead = {
      handle,
      status: 'running',
      tail: ['\x1b[32mBuild finished\x1b[0m', '```typescript', 'export const value = 42', '```'],
      truncated: false,
      nextCursor: null
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.read') {
        return Promise.resolve({ id: '2', ok: true, result: { terminal: readResult } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // 1. Default read formats code and cleans ANSI
    await BRIDGE_HANDLERS['bridge read']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1']
    })
    expect(stdoutWrite).toHaveBeenLastCalledWith(expect.stringContaining('╭── [typescript]'))
    expect(stdoutWrite).toHaveBeenLastCalledWith(expect.not.stringContaining('\x1b[32m'))

    // 2. --raw read preserves ANSI and original text
    await BRIDGE_HANDLERS['bridge read']({
      flags: new Map([['raw', true]]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1']
    })
    expect(stdoutWrite).toHaveBeenLastCalledWith(
      expect.stringContaining('\x1b[32mBuild finished\x1b[0m')
    )

    // 3. --compact read applies compaction
    const longReadResult: RuntimeTerminalRead = {
      handle,
      status: 'running',
      tail: [
        '> Run test suite',
        '$ pnpm test',
        'test output line '.repeat(100),
        '> Summary',
        'Completed'
      ],
      truncated: false,
      nextCursor: null
    }
    call.mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.read') {
        return Promise.resolve({ id: '2', ok: true, result: { terminal: longReadResult } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    await BRIDGE_HANDLERS['bridge read']({
      flags: new Map([['compact', true]]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1']
    })
    expect(stdoutWrite).toHaveBeenLastCalledWith(expect.stringContaining('[fast-jev-compaction'))
  })

  it('bridge keys translates Enter and Escape and clears read guard', async () => {
    const handle = 'term_keys_test'
    const listResult: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle, index: 1, target: '@1' })],
      totalCount: 1,
      truncated: false
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.send') {
        return Promise.resolve({ id: '2', ok: true, result: { send: { accepted: true } } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    // Bypass read guard using --no-read-guard
    await BRIDGE_HANDLERS['bridge keys']({
      flags: new Map([['no-read-guard', true]]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@1', 'Enter', 'Escape']
    })

    expect(call).toHaveBeenCalledWith('terminal.send', expect.objectContaining({ enter: true }))
    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: '\x1b', enter: false })
    )
  })

  it('bridge send emits a2a link trace on success', async () => {
    const handle = 'term_target'
    const listResult: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle, index: 5, target: '@5' })],
      totalCount: 1,
      truncated: false
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.send') {
        return Promise.resolve({ id: '2', ok: true, result: { send: { accepted: true } } })
      }
      if (method === 'terminal.a2aLink') {
        return Promise.resolve({ id: '3', ok: true, result: { ok: true, id: 'a2a-1' } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    process.env.ORCA_TERMINAL_INDEX = '2'
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'

    await BRIDGE_HANDLERS['bridge send']({
      flags: new Map([['no-read-guard', true]]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@5', 'npm test']
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.a2aLink',
      expect.objectContaining({
        from: '@2',
        to: '@5',
        fromIndex: 2,
        toIndex: 5,
        type: 'send',
        text: 'npm test'
      })
    )
  })

  it('bridge trace emits explicit a2a link with custom text and flags', async () => {
    const handle = 'term_target_8'
    const listResult: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle, index: 8, target: '@8' })],
      totalCount: 1,
      truncated: false
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ id: '1', ok: true, result: listResult })
      }
      if (method === 'terminal.a2aLink') {
        return Promise.resolve({ id: '2', ok: true, result: { ok: true, id: 'a2a-trace-8' } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge trace']({
      flags: new Map([
        ['from', '@2'],
        ['type', 'message']
      ]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@8', 'sync state']
    })

    expect(call).toHaveBeenCalledWith(
      'terminal.a2aLink',
      expect.objectContaining({
        from: '@2',
        to: '@8',
        fromIndex: 2,
        toIndex: 8,
        type: 'message',
        text: 'sync state'
      })
    )
    expect(log).toHaveBeenCalledWith('Trace emitted: @2 -> @8 (sync state)')
  })

  it('bridge list prints both terminals and browser tabs with @b targets', async () => {
    const termList: RuntimeTerminalListResult = {
      terminals: [fakeTerminal({ handle: 'term_1', index: 1, target: '@1' })],
      totalCount: 1,
      truncated: false
    }
    const browserList = {
      tabs: [
        {
          browserPageId: 'page_123',
          index: 1,
          url: 'https://twin3.ai',
          title: 'twin3 · Personal Agent',
          active: true
        }
      ]
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'terminal.list') {
        return Promise.resolve({ ok: true, result: termList })
      }
      if (method === 'browser.tabList') {
        return Promise.resolve({ ok: true, result: browserList })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge list']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false
    })

    const output = String(log.mock.calls[0]?.[0] ?? '')
    expect(output).toContain('@1')
    expect(output).toContain('Browsers:')
    expect(output).toContain('@b1')
    expect(output).toContain('twin3 · Personal Agent')
    expect(output).toContain('page_123')
  })

  it('bridge resolve resolves @b1 to browserPageId', async () => {
    const browserList = {
      tabs: [
        {
          browserPageId: 'page_456',
          index: 1,
          url: 'https://example.com',
          title: 'Example Domain',
          active: true
        }
      ]
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'browser.tabList') {
        return Promise.resolve({ ok: true, result: browserList })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge resolve']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@b1']
    })

    expect(log).toHaveBeenCalledWith('page_456')
  })

  it('bridge read @b1 takes snapshot and arms read guard for bridge send', async () => {
    const browserList = {
      tabs: [
        {
          browserPageId: 'page_789',
          index: 1,
          url: 'https://example.com',
          title: 'Example',
          active: true
        }
      ]
    }
    const snapshotResult = {
      title: 'Example',
      url: 'https://example.com',
      nodes: [{ id: 1, role: 'button', name: 'Submit' }]
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'browser.tabList') {
        return Promise.resolve({ ok: true, result: browserList })
      }
      if (method === 'browser.snapshot') {
        return Promise.resolve({ ok: true, result: snapshotResult })
      }
      if (method === 'browser.click') {
        return Promise.resolve({ ok: true, result: { clicked: '#submit-btn' } })
      }
      if (method === 'terminal.a2aLink') {
        return Promise.resolve({ ok: true, result: { ok: true } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // 1. Read the browser tab
    await BRIDGE_HANDLERS['bridge read']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@b1']
    })

    expect(call).toHaveBeenCalledWith('browser.snapshot', { page: 'page_789' })

    // 2. Send command to the browser tab (guarded by previous read)
    await BRIDGE_HANDLERS['bridge send']({
      flags: new Map(),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@b1', 'click #submit-btn']
    })

    expect(call).toHaveBeenCalledWith('browser.click', {
      element: '#submit-btn',
      page: 'page_789'
    })
    expect(log).toHaveBeenCalledWith('[@b1] Clicked #submit-btn')
  })

  it('bridge message @b1 navigates browser tab to URL', async () => {
    const browserList = {
      tabs: [
        {
          browserPageId: 'page_999',
          index: 1,
          url: 'about:blank',
          title: 'New Tab',
          active: true
        }
      ]
    }

    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'browser.tabList') {
        return Promise.resolve({ ok: true, result: browserList })
      }
      if (method === 'browser.openUrl') {
        return Promise.resolve({ ok: true, result: { browserPageId: 'page_999' } })
      }
      if (method === 'terminal.a2aLink') {
        return Promise.resolve({ ok: true, result: { ok: true } })
      }
      return Promise.reject(new Error(`unexpected method: ${method}`))
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await BRIDGE_HANDLERS['bridge message']({
      flags: new Map([['no-read-guard', true]]),
      client: toMockClient(call),
      cwd: '/workspaces/proj',
      json: false,
      rawArgs: ['@b1', 'https://twin3.ai']
    })

    expect(call).toHaveBeenCalledWith(
      'browser.openUrl',
      expect.objectContaining({
        url: 'https://twin3.ai'
      })
    )
    expect(log).toHaveBeenCalledWith('[@b1] Navigated to https://twin3.ai')
  })
})
