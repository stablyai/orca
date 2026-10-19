import { homedir } from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const mocks = vi.hoisted(() => ({
  refreshed: new Set<() => void>(),
  observe: vi.fn(),
  recapture: vi.fn(async () => {})
}))
vi.mock('../preflight/workspace-agent-detection', () => ({
  onAgentsRefreshedOnHost: (listener: () => void) => mocks.refreshed.add(listener)
}))
vi.mock('./structured-agent-launch-support', () => ({
  observeStructuredAgentLaunch: mocks.observe
}))
vi.mock('./structured-agent-shell-environment', () => ({
  recaptureHostShellEnvironment: mocks.recapture
}))
// Grok stands for an agent this host cannot supervise (Windows without process start times).
vi.mock('./structured-agent-runtime-metadata', () => ({
  STRUCTURED_AGENT_RUNTIME_METADATA: ['claude', 'grok', 'pi', 'opencode'].map((agent) => ({
    definition: { agent },
    supportsLocation: () => agent !== 'grok'
  }))
}))

import { installStructuredAgentAvailability } from './structured-agent-availability'

beforeEach(() => {
  mocks.refreshed.clear()
  mocks.observe.mockReset().mockResolvedValue('supported')
  mocks.recapture.mockReset().mockResolvedValue(undefined)
})

function install() {
  const listeners: ((updates: Partial<GlobalSettings>, settings: GlobalSettings) => void)[] = []
  const store = {
    onSettingsChanged: (listener: (typeof listeners)[number]) => {
      listeners.push(listener)
      return () => {}
    }
  }
  const availability = installStructuredAgentAvailability(store, {
    requireStore: () => ({ getSettings: () => getDefaultSettings('/home/test') })
  })
  const change = (updates: Partial<GlobalSettings>): void =>
    listeners.forEach((listener) => listener(updates, getDefaultSettings('/home/test')))
  return { availability, change }
}

it('shares a host-home snapshot even if shell recapture fails, retaining it without readers', async () => {
  mocks.recapture.mockRejectedValueOnce(new Error('shell capture failed'))
  const cwds: string[] = []
  mocks.observe.mockImplementation(async (agent: string, cwd: () => Promise<string>) => {
    cwds.push(await cwd())
    if (agent === 'pi') {
      throw new Error('Command setting not runnable')
    }
    return agent === 'opencode' ? 'unsupported' : 'supported'
  })
  const { availability } = install()
  const first = vi.fn()
  const release = availability.subscribe(first)
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
  release()
  expect(first.mock.calls[0][0]).toEqual([
    { agent: 'claude', state: 'available' },
    { agent: 'grok', state: 'refused', reason: 'agent' },
    // A check that could not answer is no verdict.
    { agent: 'pi', state: 'unknown' },
    { agent: 'opencode', state: 'refused', reason: 'agent' }
  ])
  expect(cwds).toEqual([homedir(), homedir(), homedir()])
  // Kept with no readers: a later one reads it at once, without probing again.
  const later = vi.fn()
  availability.subscribe(later)
  expect(later).toHaveBeenCalledWith(first.mock.calls[0][0])
  expect(mocks.observe).toHaveBeenCalledTimes(3)
})

it('replaces the snapshot on a launch setting or Refresh, which first recaptures the shell', async () => {
  const { availability, change } = install()
  const read = vi.fn()
  availability.subscribe(read)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  change({ terminalFontSize: 14 })
  change({ agentCmdOverrides: { pi: '/opt/pi' } })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const capture = Promise.withResolvers<void>()
  let version = 'unsupported'
  mocks.observe.mockImplementation(async () => version)
  mocks.recapture.mockImplementation(() => capture.promise)
  mocks.refreshed.forEach((listener) => listener())
  change({ agentDefaultEnv: { pi: { PI_TEST: 'updated' } } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(read).toHaveBeenCalledTimes(2)
  expect(mocks.observe).toHaveBeenCalledTimes(6)
  version = 'supported'
  capture.resolve()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  expect(read.mock.lastCall?.[0]).toContainEqual({ agent: 'opencode', state: 'available' })
})

it('captures fresh shell facts for a first subscriber even when Refresh had no listener', async () => {
  const capture = Promise.withResolvers<void>()
  let version = 'unsupported'
  mocks.observe.mockImplementation(async () => version)
  mocks.recapture.mockImplementation(() => capture.promise)
  mocks.refreshed.forEach((listener) => listener())
  const { availability } = install()
  const read = vi.fn()
  availability.subscribe(read)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mocks.observe).not.toHaveBeenCalled()
  version = 'supported'
  capture.resolve()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(read.mock.lastCall?.[0]).toContainEqual({ agent: 'opencode', state: 'available' })
})
