import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.fn()
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))

import { sweepOrphanedAgentBrowserSessions } from './agent-browser-orphan-sweep'

type Spec = { args?: readonly string[] }

const BIN = '/opt/orca/agent-browser'
const SCOPED = {
  env: { AGENT_BROWSER_SOCKET_DIR: '/tmp/orca-ab-0123456789abcdef' },
  ownsSocketDirectory: true
}

function respond(sessions: string[]): void {
  runProcessMock.mockImplementation((spec: Spec) => {
    if (spec.args?.[0] === 'session') {
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data: { sessions } }),
        stderr: '',
        timedOut: false
      })
    }
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
  })
}

function closedArgs(): string[][] {
  return runProcessMock.mock.calls
    .map((call) => [...((call[0] as Spec).args ?? [])])
    .filter((args) => args.includes('close'))
}

describe('agent-browser orphan sweep', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('closes tab daemons left by a previous run', async () => {
    respond(['orca-tab-aaa', 'orca-tab-bbb'])

    const closed = await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    expect(closed).toEqual(['orca-tab-aaa', 'orca-tab-bbb'])
    expect(closedArgs()).toEqual([
      ['--session', 'orca-tab-aaa', 'close'],
      ['--session', 'orca-tab-bbb', 'close']
    ])
  })

  it('never closes a daemon outside Orca tab naming', async () => {
    respond(['default', 'agent1', 'orca-orcad-deadbeef', 'orca-tab-aaa'])

    await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    expect(closedArgs()).toEqual([['--session', 'orca-tab-aaa', 'close']])
  })

  it('leaves sessions this run already owns alone', async () => {
    respond(['orca-tab-live', 'orca-tab-orphan'])

    await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      ...SCOPED,
      isSessionLive: (name) => name === 'orca-tab-live'
    })

    expect(closedArgs()).toEqual([['--session', 'orca-tab-orphan', 'close']])
  })

  // Why: without a socket dir Orca derived itself, `session list` can reach daemons another Orca
  // profile owns (Windows named pipes, or an inherited AGENT_BROWSER_SOCKET_DIR). Idle timeout bounds those.
  it.each([
    ['no socket directory at all', { PATH: 'C:\\Windows' }],
    ['a socket directory Orca inherited', { AGENT_BROWSER_SOCKET_DIR: '/tmp/shared-ab' }]
  ])('does not enumerate with %s', async (_label, env) => {
    respond(['orca-tab-aaa'])

    const closed = await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      env,
      ownsSocketDirectory: false
    })

    expect(closed).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('closes nothing when the listing is unusable', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: 'not json',
      stderr: 'boom',
      timedOut: false
    })

    await expect(
      sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
    ).resolves.toEqual([])
    expect(closedArgs()).toEqual([])
  })

  it('survives a listing that never returns', async () => {
    runProcessMock.mockRejectedValue(new Error('ENOENT'))

    await expect(
      sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
    ).resolves.toEqual([])
  })

  it('keeps sweeping after one close fails', async () => {
    runProcessMock.mockImplementation((spec: Spec) => {
      if (spec.args?.[0] === 'session') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ data: { sessions: ['orca-tab-aaa', 'orca-tab-bbb'] } }),
          stderr: '',
          timedOut: false
        })
      }
      if (spec.args?.[1] === 'orca-tab-aaa') {
        return Promise.reject(new Error('spawn failed'))
      }
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    })

    const closed = await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    expect(closed).toEqual(['orca-tab-bbb'])
  })

  it('bounds every child it starts', async () => {
    respond(['orca-tab-aaa'])

    await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    for (const call of runProcessMock.mock.calls) {
      expect((call[0] as { timeoutMs?: number | null }).timeoutMs).toBeGreaterThan(0)
    }
  })
})

describe('sweep kill switch', () => {
  const previous = process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP
    } else {
      process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP = previous
    }
  })

  // Why: the idle bound is an env passthrough an operator can raise and the quit close is
  // self-bounded, so the sweep is the only new behaviour whose failure would need a revert.
  it('enumerates nothing when disabled, even when Orca owns the socket directory', async () => {
    process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP = '1'
    runProcessMock.mockClear()

    const closed = await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      env: {},
      ownsSocketDirectory: true
    })

    expect(closed).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('still sweeps when the flag holds any other value', async () => {
    process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP = '0'
    runProcessMock.mockClear()
    runProcessMock.mockResolvedValue({ code: 0, stdout: '{"data":{"sessions":[]}}', stderr: '' })

    await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      env: {},
      ownsSocketDirectory: true
    })

    expect(runProcessMock).toHaveBeenCalled()
  })
})
