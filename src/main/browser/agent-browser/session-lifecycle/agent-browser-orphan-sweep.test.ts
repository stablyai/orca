import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.fn()
const lstatMock = vi.fn()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))
vi.mock('node:fs', () => ({ lstatSync: (...args: unknown[]) => lstatMock(...args) }))

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
    lstatMock.mockReset().mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
  })

  it('leaves sessions this run already owns alone', async () => {
    respond(['orca-tab-live', 'orca-tab-orphan'])

    const closed = await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      ...SCOPED,
      isSessionLive: (name) => name === 'orca-tab-live'
    })

    expect(closedArgs()).toEqual([['--session', 'orca-tab-orphan', 'close']])
    expect(closed).toEqual(['orca-tab-orphan'])
  })

  it('keeps sweeping after one close fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
        return Promise.reject(new Error('sensitive spawn failure'))
      }
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    })

    try {
      const closed = await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
      expect(closed).toEqual(['orca-tab-bbb'])
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not report a session as closed when its exit cannot be verified', async () => {
    respond(['orca-tab-private', 'orca-tab-next'])
    lstatMock.mockImplementation((path: string) => {
      if (path.endsWith('orca-tab-private.sock')) return {}
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const closed = sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
      await vi.runAllTimersAsync()
      await expect(closed).resolves.toEqual(['orca-tab-next'])
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain('orca-tab-private')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    ['nonzero exit', { code: 1, signal: null, timedOut: false }],
    ['timeout', { code: 0, signal: null, timedOut: true }],
    ['signal', { code: null, signal: 'SIGTERM', timedOut: false }],
    ['unverified exit', { code: null, signal: null, timedOut: false }]
  ])('does not report a %s as closed and continues sweeping', async (_label, failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runProcessMock.mockImplementation((spec: Spec) => {
      if (spec.args?.[0] === 'session') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ data: { sessions: ['orca-tab-private', 'orca-tab-next'] } }),
          stderr: '',
          timedOut: false
        })
      }
      if (spec.args?.[1] === 'orca-tab-private') {
        return Promise.resolve({
          ...failure,
          stdout: 'sensitive output',
          stderr: 'sensitive error'
        })
      }
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    })

    try {
      await expect(
        sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
      ).resolves.toEqual(['orca-tab-next'])
      expect(closedArgs()).toEqual([
        ['--session', 'orca-tab-private', 'close'],
        ['--session', 'orca-tab-next', 'close']
      ])
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/orca-tab-private|sensitive/)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not trust a successful-looking listing from a failed process', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: JSON.stringify({ data: { sessions: ['orca-tab-unsafe'] } }),
      stderr: '',
      timedOut: false
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
      ).resolves.toEqual([])
      expect(closedArgs()).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not close sessions from an unsuccessful listing response', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: JSON.stringify({ success: false, data: { sessions: ['orca-tab-unsafe'] } }),
      stderr: '',
      timedOut: false
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
      ).resolves.toEqual([])
      expect(closedArgs()).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
