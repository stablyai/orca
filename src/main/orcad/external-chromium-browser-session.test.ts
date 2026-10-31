import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'

const runProcessMock = vi.fn<(spec: Spec) => Promise<unknown>>()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: Spec) => runProcessMock(spec)
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('')),
  rm: vi.fn(async () => undefined)
}))

import {
  ExternalChromiumBrowserSession,
  externalChromiumAgentBrowserEnvironment
} from './external-chromium-browser-session'
import { agentBrowserCommandOf } from '../browser/agent-browser-bridge-test-harness'

const BASE = {
  executablePath: '/opt/orca/chromium',
  profilePath: '/state/browser-chromium',
  sessionName: 'orca-orcad-0123456789abcdef'
}

type Spec = {
  args?: readonly string[]
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

function commandOf(spec: Spec): string[] {
  return agentBrowserCommandOf(spec.args ?? [], spec.input)
}

function commands(): string[][] {
  return runProcessMock.mock.calls.map(([spec]) => commandOf(spec))
}

describe('orcad external-chromium agent-browser environment', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    vi.mocked(mkdir).mockClear()
  })

  it('does no work when startup is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mkdir).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it.each(['tab', 'close', 'open'])(
    'does not continue startup after abort during %s',
    async (phase) => {
      const controller = new AbortController()
      runProcessMock.mockImplementation(async (spec: Spec) => {
        if (commandOf(spec)[0] === phase) {
          controller.abort()
        }
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({ success: true, data: { tabs: [] } }),
          stderr: '',
          timedOut: false
        }
      })
      const session = new ExternalChromiumBrowserSession(
        '/opt/orca/agent-browser',
        { executablePath: BASE.executablePath, provider: 'chromium' },
        '/state'
      )
      await expect(session.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      const specs = runProcessMock.mock.calls.map(([spec]) => spec)
      const issued = specs.map((spec) => commandOf(spec)[0])
      expect(issued).toEqual(
        phase === 'tab' ? ['tab'] : phase === 'close' ? ['tab', 'close'] : ['tab', 'close', 'open']
      )
      for (const spec of specs) {
        expect(spec.signal).toBe(commandOf(spec)[0] === 'close' ? undefined : controller.signal)
      }
      await session.stop()
      expect(runProcessMock.mock.lastCall?.[0]).toMatchObject({ signal: undefined })
      expect(commands().at(-1)).toEqual(['close'])
    }
  )

  it('reports a ref whose element is gone as stale', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: JSON.stringify({
        success: false,
        error:
          'Stale ref for role=button name=Approve cannot be recovered: several elements now match.'
      }),
      stderr: '',
      timedOut: false
    })
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.run(['click', '@e2'])).rejects.toMatchObject({ code: 'browser_stale_ref' })
  })

  it('never bounds the daemon that owns the Chromium tree', () => {
    const env = externalChromiumAgentBrowserEnvironment({ inheritedEnv: {}, ...BASE })

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('0')
    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(BASE.executablePath)
    expect(env.AGENT_BROWSER_SESSION).toBe(BASE.sessionName)
  })

  it('passes an operator-set idle timeout through untouched', () => {
    const env = externalChromiumAgentBrowserEnvironment({
      inheritedEnv: { AGENT_BROWSER_IDLE_TIMEOUT_MS: '1234' },
      ...BASE
    })

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('1234')
  })

  it('keeps launch arguments joined for the daemon', () => {
    const env = externalChromiumAgentBrowserEnvironment({
      inheritedEnv: {},
      ...BASE,
      browserArgs: ['--headless=new', '--no-sandbox']
    })

    expect(env.AGENT_BROWSER_ARGS).toBe('--headless=new\n--no-sandbox')
  })

  it("reuses a surviving session instead of closing the user's browser", async () => {
    runProcessMock.mockImplementation((spec: Spec) => {
      const data =
        commandOf(spec)[0] === 'tab'
          ? { tabs: [{ active: true, tabId: 'tab-live', title: 'x', url: 'https://example.test' }] }
          : {}
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data }),
        stderr: '',
        timedOut: false
      })
    })

    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.start()).resolves.toBe('tab-live')

    const issued = commands().map(([name]) => name)
    expect(issued).not.toContain('close')
    expect(issued).not.toContain('open')
  })

  it('selects a tab only when it is not already active, keeping the snapshot refs', async () => {
    runProcessMock.mockImplementation(() => {
      const tabs = [
        { active: true, tabId: 't1', title: 'a', url: 'about:blank' },
        { active: false, tabId: 't2', title: 'b', url: 'about:blank' }
      ]
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data: { tabs } }),
        stderr: '',
        timedOut: false
      })
    })
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )

    await session.selectPage('t1')
    expect(commands()).toEqual([['tab']])
    await session.selectPage('t2')
    expect(commands()).toEqual([['tab'], ['tab'], ['tab', 't2']])
  })

  it('reclaims a session that answers nothing, then opens', async () => {
    let listed = 0
    runProcessMock.mockImplementation((spec: Spec) => {
      if (commandOf(spec)[0] === 'tab') {
        listed += 1
        const tabs =
          listed === 1 ? [] : [{ active: true, tabId: 'tab-1', title: 'x', url: 'about:blank' }]
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ success: true, data: { tabs } }),
          stderr: '',
          timedOut: false
        })
      }
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data: {} }),
        stderr: '',
        timedOut: false
      })
    })

    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.start()).resolves.toBe('tab-1')

    const issued = commands().map(([name]) => name)
    expect(issued).toContain('close')
    expect(issued).toContain('open')
  })
})
