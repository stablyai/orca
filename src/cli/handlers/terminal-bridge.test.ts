import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalListResult, RuntimeTerminalSummary } from '../../shared/runtime-types'
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
})
