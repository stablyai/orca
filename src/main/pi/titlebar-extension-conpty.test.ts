import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { createHarness } from './titlebar-extension-test-harness'

const WORKING_TITLE = '⠋ π - omp-session - orca-app'
const IDLE_TITLE = 'π - omp-session - orca-app'
const PROMPT_TITLE = 'π ! omp-session - orca-app'

const CONSOLE_HOSTS = [
  { name: 'Windows', platform: 'win32', env: {} },
  { name: 'WSL distro', platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } },
  { name: 'WSL interop', platform: 'linux', env: { WSL_INTEROP: '/run/WSL/1_interop' } }
] as const

describe('Pi title output on console hosts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(CONSOLE_HOSTS)(
    'bounds $name working heartbeats without changing title state',
    async (host) => {
      const harness = createHarness(host)
      await harness.callHook('agent_start')
      expect(harness.lastTitle()).toBe(WORKING_TITLE)
      vi.advanceTimersByTime(499)
      expect(harness.titles).toEqual([WORKING_TITLE])
      vi.advanceTimersByTime(4501)
      expect(harness.titles).toHaveLength(11)
      expect(new Set(harness.titles)).toEqual(new Set([WORKING_TITLE]))
      expect(detectAgentStatusFromTitle(WORKING_TITLE)).toBe('working')
      await harness.callHook('agent_settled')
      expect(harness.lastTitle()).toBe(IDLE_TITLE)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(CONSOLE_HOSTS)('keeps $name dialog transitions immediate', async (host) => {
    const harness = createHarness(host)
    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    vi.advanceTimersByTime(1000)
    expect(harness.lastTitle()).toBe(PROMPT_TITLE)
    await harness.callHook('ui_prompt_end')
    expect(harness.lastTitle()).toBe(WORKING_TITLE)
    await harness.callHook('session_shutdown')
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(CONSOLE_HOSTS)('caps $name idle maintenance at five minutes', async (host) => {
    const harness = createHarness(host)
    await harness.callHook('auto_compaction_start', { reason: 'idle' })
    vi.advanceTimersByTime(299999)
    expect(harness.lastTitle()).toBe(WORKING_TITLE)
    vi.advanceTimersByTime(1)
    expect(harness.lastTitle()).toBe(IDLE_TITLE)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['darwin', 'linux'] as const)('keeps native %s animation', async (platform) => {
    const harness = createHarness({ platform })
    await harness.callHook('agent_start')
    vi.advanceTimersByTime(80)
    expect(harness.titles).toEqual([WORKING_TITLE, '⠙ π - omp-session - orca-app'])
    await harness.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(0)
  })
})
