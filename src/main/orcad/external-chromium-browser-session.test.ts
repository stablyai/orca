import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'

const runProcessMock = vi.fn()
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
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

const BASE = {
  executablePath: '/opt/orca/chromium',
  profilePath: '/state/browser-chromium',
  sessionName: 'orca-orcad-0123456789abcdef'
}

type Spec = { args?: readonly string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal }

function commands(): string[][] {
  return runProcessMock.mock.calls.map((call) => [...((call[0] as Spec).args ?? [])])
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
        if (spec.args?.includes(phase)) {
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
      const specs = runProcessMock.mock.calls.map(([spec]) => spec as Spec)
      const issued = specs.map((spec) =>
        spec.args?.find((arg) => ['tab', 'close', 'open'].includes(arg))
      )
      expect(issued).toEqual(
        phase === 'tab' ? ['tab'] : phase === 'close' ? ['tab', 'close'] : ['tab', 'close', 'open']
      )
      for (const spec of specs) {
        expect(spec.signal).toBe(spec.args?.includes('close') ? undefined : controller.signal)
      }
      await session.stop()
      expect(runProcessMock.mock.lastCall?.[0]).toMatchObject({ signal: undefined })
      expect(commands().at(-1)).toContain('close')
    }
  )

  // Why: this daemon owns the user's remote Chromium, so an idle bound would close a live browser.
  it('never bounds the daemon that owns the Chromium tree', () => {
    const env = externalChromiumAgentBrowserEnvironment({ inheritedEnv: {}, ...BASE })

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined()
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

  // Why (#16367): orcad is the backend a remote user's Chromium hangs off, and this session
  // never passes --cdp, so a daemon an earlier orcad left behind is not bound to the dead
  // process. Closing it on every start would take their browser and every tab with it.
  it("reuses a surviving session instead of closing the user's browser", async () => {
    runProcessMock.mockImplementation((spec: Spec) => {
      const data = spec.args?.includes('tab')
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

    const issued = commands().map((args) => args.filter((arg) => !arg.startsWith('-')))
    expect(issued.some((args) => args.includes('close'))).toBe(false)
    expect(issued.some((args) => args.includes('open'))).toBe(false)
  })

  // Why: a name that answers nothing is wedged or half-dead, so reclaiming it is correct —
  // that is the killed-orcad case the stable session name exists to recover.
  it('reclaims a session that answers nothing, then opens', async () => {
    let listed = 0
    runProcessMock.mockImplementation((spec: Spec) => {
      if (spec.args?.includes('tab')) {
        listed += 1
        // First probe finds nothing; after `open` the page exists.
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

    const issued = commands().map((args) => args.filter((arg) => !arg.startsWith('-')))
    expect(issued.some((args) => args.includes('close'))).toBe(true)
    expect(issued.some((args) => args.includes('open'))).toBe(true)
  })
})
