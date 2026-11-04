import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeTypes from '../runtime/types'

const callMock = vi.fn()

vi.mock('../runtime/types', () => {
  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return { RuntimeClientError, RuntimeRpcFailureError }
})

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  const { RuntimeClientError, RuntimeRpcFailureError } =
    await vi.importMock<typeof RuntimeTypes>('../runtime/types')

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { RuntimeClientError } from '../runtime/types'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from '../test-fixtures'

describe('orca cli browser page targeting', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('passes explicit page ids to snapshot without resolving the current worktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['snapshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.snapshot', { page: 'page-1' })
  })

  it('sends snapshot flags to the host and prints delta changes against the last tree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: {
          kind: 'delta',
          revision: 3,
          baseRevision: 2,
          treeChange: { startLine: 4, deleteCount: 2, lines: ['- button "Save" [ref=e9]'] }
        },
        url: 'https://example.com',
        title: 'Example'
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'snapshot',
        '--page',
        'page-1',
        '--interactive',
        '--depth',
        '3',
        '--selector',
        'form',
        '--delta'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.snapshot', {
      page: 'page-1',
      interactive: true,
      depth: 3,
      selector: 'form',
      delta: true
    })
    expect(log).toHaveBeenCalledWith(
      [
        'page: page-1',
        'Example — https://example.com',
        'revision 3: changes to revision 2; replace lines 5-6 with:',
        '- button "Save" [ref=e9]'
      ].join('\n')
    )
  })

  it('saves screenshots where the CLI runs and prints the path instead of base64', async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), 'orca-browser-shot-'))
    vi.stubEnv('ORCA_BROWSER_SCREENSHOT_TMPDIR', screenshotDir)
    queueFixtures(
      callMock,
      okFixture('req_shot', { data: Buffer.from('png-bytes').toString('base64'), format: 'png' }),
      okFixture('req_unchanged', { data: '', format: 'png', changed: false })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await main(['screenshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')
      await main(['screenshot', '--page', 'page-1', '--if-changed'], '/tmp/not-an-orca-worktree')

      const saved = JSON.parse(String(log.mock.calls[0][0])).result
      expect(saved.data).toBeUndefined()
      expect(saved.path).toBe(join(screenshotDir, 'req_shot-screenshot.png'))
      expect(readFileSync(saved.path, 'utf8')).toBe('png-bytes')
      expect(callMock).toHaveBeenLastCalledWith('browser.screenshot', {
        page: 'page-1',
        ifChanged: true
      })
      expect(log).toHaveBeenLastCalledWith(
        'Screenshot unchanged since the last --if-changed capture; nothing saved'
      )
    } finally {
      rmSync(screenshotDir, { recursive: true, force: true })
    }
  })

  it('resolves current worktree only when --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_snapshot', {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['snapshot', '--page', 'page-1', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.snapshot', {
      page: 'page-1',
      worktree: 'id:repo::/tmp/repo/feature'
    })
  })

  it('passes page-targeted tab switches through without auto-scoping to the current worktree', async () => {
    queueFixtures(callMock, okFixture('req_switch', { switched: 2, browserPageId: 'page-2' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'switch', '--page', 'page-2', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSwitch', {
      index: undefined,
      page: 'page-2'
    })
    expect(callMock.mock.calls[0][1]).not.toHaveProperty('focus')
  })

  it('still resolves the current worktree when tab switch --page is combined with --worktree current', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_switch', { switched: 2, browserPageId: 'page-2' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'switch', '--page', 'page-2', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.tabSwitch', {
      index: undefined,
      page: 'page-2',
      worktree: 'id:repo::/tmp/repo/feature'
    })
  })

  it('asks for a split beside the calling terminal tab with --split', async () => {
    vi.stubEnv('ORCA_TAB_ID', 'terminal-tab-1')
    queueFixtures(callMock, okFixture('req_create', { browserPageId: 'page-4' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'create', '--url', 'https://example.com', '--split', 'right', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.tabCreate',
      {
        url: 'https://example.com',
        worktree: undefined,
        profileId: undefined,
        split: 'right',
        splitFromTabId: 'terminal-tab-1'
      },
      { timeoutMs: 60_000 }
    )
    vi.unstubAllEnvs()
  })

  it('leaves the caller tab out of a plain tab create', async () => {
    vi.stubEnv('ORCA_TAB_ID', 'terminal-tab-1')
    queueFixtures(callMock, okFixture('req_create', { browserPageId: 'page-5' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'create', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(callMock.mock.calls[0][1]).not.toHaveProperty('split')
    expect(callMock.mock.calls[0][1]).not.toHaveProperty('splitFromTabId')
    vi.unstubAllEnvs()
  })

  it('rejects an unknown --split direction before calling the runtime', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['tab', 'create', '--split', 'sideways'], '/tmp/not-an-orca-worktree')

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('--split must be right, left, down, or up')
  })

  it('rejects --split with no direction instead of opening a plain tab', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['tab', 'create', '--split='], '/tmp/not-an-orca-worktree')

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('Missing value for --split')
  })

  it('opens browser-launch URLs on the client hosting the current worktree', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_open_url', { browserPageId: 'page-local' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['open-url', '--url', 'https://example.com/login', '--json'], '/tmp/repo/feature')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'browser.openUrl',
      {
        url: 'https://example.com/login',
        worktree: 'id:repo::/tmp/repo/feature'
      },
      { timeoutMs: 60_000 }
    )
  })

  it('creates a tab in the calling folder workspace, not the parent sharing its path (#33618)', async () => {
    const parent = buildWorktree('/tmp/folder', '')
    const workspace = { ...parent, id: `${parent.id}::workspace:ws-2` }
    queueFixtures(
      callMock,
      worktreeListFixture([parent, workspace]),
      okFixture('req_tab_create', { browserPageId: 'page-1' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('ORCA_WORKTREE_ID', workspace.id)

    await main(['tab', 'create', '--url', 'https://example.com', '--json'], '/tmp/folder')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'browser.tabCreate',
      { url: 'https://example.com', worktree: `id:${workspace.id}` },
      { timeoutMs: 60_000 }
    )
  })
})

describe('orca cli browser identity', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gets the host identity only after capability negotiation', async () => {
    queueFixtures(
      callMock,
      okFixture('status', { capabilities: ['browser.identity.v1'] }),
      okFixture('identity', {
        identity: {
          state: 'valid',
          appliedMode: 'clean',
          configuredMode: 'native',
          explicitSelection: true,
          migrationNoticePending: false,
          restartRequired: true
        },
        migrationNotice: null
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['browser', 'identity', 'get', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.identity.get')
  })

  it('refuses an older runtime instead of guessing at identity support', async () => {
    queueFixtures(callMock, okFixture('status', { capabilities: [] }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['browser', 'identity', 'get'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Update or restart Orca'))
  })
})

describe('orca cli browser tab profiles', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects unknown --scope values instead of silently defaulting to isolated', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['tab', 'profile', 'create', '--label', 'Work', '--scope', 'isloated'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('--scope must be "isolated" or "imported"')
  })

  it('surfaces a runtime error if the registry refuses to create a profile', async () => {
    queueFixtures(callMock, okFixture('req_profile_create', { profile: null }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['tab', 'profile', 'create', '--label', 'Bogus'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to create browser profile (label=Bogus, scope=isolated)'
    )
  })
})

describe('orca cli browser cookies', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes a finite non-negative cookie expiry through as a number', async () => {
    queueFixtures(callMock, okFixture('req_cookie', { success: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'cookie',
        'set',
        '--name',
        'sid',
        '--value',
        'x',
        '--expires',
        '0',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.cookie.set', {
      name: 'sid',
      value: 'x',
      expires: 0,
      worktree: undefined
    })
  })

  it.each(['not-a-number', 'Infinity', '-1'])(
    'rejects invalid cookie expiry value %s before RPC dispatch',
    async (expires) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const priorExitCode = process.exitCode

      await main(
        ['cookie', 'set', '--name', 'sid', '--value', 'x', '--expires', expires],
        '/tmp/not-an-orca-worktree'
      )

      expect(callMock).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.flat().join('\n')).toContain(`Invalid --expires value: ${expires}`)
      expect(process.exitCode).toBe(1)

      process.exitCode = priorExitCode
    }
  )

  it('rejects --expires without a value before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['cookie', 'set', '--name', 'sid', '--value', 'x', '--expires'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing value for --expires.')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})

describe('orca cli browser waits and viewport flags', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives selector waits an explicit RPC timeout budget', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: undefined,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 60_000 }
    )
  })

  it('extends selector wait RPC timeout when the user passes --timeout', async () => {
    queueFixtures(callMock, okFixture('req_wait', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--timeout', '45000', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: 45000,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 75000 }
    )
  })

  it('does not tell users Orca is down for a generic runtime timeout', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['wait', '--selector', '#ready', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(errorSpy).toHaveBeenCalledWith('Timed out waiting for the Orca runtime to respond.')
  })
})
