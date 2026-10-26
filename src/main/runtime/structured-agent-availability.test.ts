import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const mocks = vi.hoisted(() => {
  const programs: Record<string, () => { command: string; env: Record<string, string> }> = {}
  return {
    refreshed: new Set<() => void>(),
    releasesChanged: new Set<() => void>(),
    observe: vi.fn(),
    recapture: vi.fn(async () => {}),
    programs,
    installable: true
  }
})
vi.mock('../preflight/workspace-agent-detection', () => ({
  onAgentsRefreshedOnHost: (listener: () => void) => mocks.refreshed.add(listener)
}))
vi.mock('../node-runtime/managed-runtime-installation', () => ({
  onManagedRuntimeReleasesChanged: (listener: () => void) => mocks.releasesChanged.add(listener)
}))
vi.mock('./structured-agent-launch-support', () => ({
  observeStructuredAgentLaunch: mocks.observe,
  resolveHostStructuredAgentLaunchEnvironment: async () => ({ PATH: '/usr/bin' })
}))
vi.mock('./structured-agent-shell-environment', () => ({
  recaptureHostShellEnvironment: mocks.recapture
}))
// Grok stands for an agent this host cannot supervise (Windows without process start times).
vi.mock('./structured-agent-runtime-metadata', () => ({
  STRUCTURED_AGENT_RUNTIME_METADATA: ['claude', 'grok', 'pi', 'opencode'].map((agent) => ({
    definition: { agent },
    supportsLocation: () => agent !== 'grok',
    ...(agent === 'grok'
      ? {}
      : {
          chatProgram: {
            resolve: () => mocks.programs[agent](),
            ...(agent === 'opencode' ? { installable: () => mocks.installable } : {})
          }
        })
  }))
}))

import { installStructuredAgentAvailability } from './structured-agent-availability'

const READY = { status: 'ready', version: '2.0.14' } as const
const TOO_OLD = { status: 'tooOld', version: '2.0.13', minimumVersion: '2.0.14' } as const
const opencodeAvailable = expect.objectContaining({ agent: 'opencode', state: 'available' })
const found =
  (command: string, PATH = '/usr/bin') =>
  () => ({ command, env: { PATH } })

beforeEach(() => {
  mocks.refreshed.clear()
  mocks.releasesChanged.clear()
  mocks.installable = true
  mocks.programs = {
    claude: found('/usr/bin/claude'),
    pi: () => {
      throw new Error('Command setting not runnable')
    },
    opencode: found('opencode')
  }
  mocks.observe.mockReset().mockResolvedValue(READY)
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
    return agent === 'opencode' ? TOO_OLD : READY
  })
  const { availability } = install()
  const first = vi.fn()
  const release = availability.subscribe(first)
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
  release()
  expect(first.mock.calls[0][0]).toEqual([
    { agent: 'claude', state: 'available', chatProgram: 'available' },
    { agent: 'grok', state: 'refused', reason: 'agent', chatProgram: 'unknown' },
    // A check that could not answer is no verdict.
    { agent: 'pi', state: 'unknown', chatProgram: 'unknown' },
    { agent: 'opencode', state: 'refused', reason: 'agent', chatProgram: 'installable' }
  ])
  expect(cwds).toEqual([homedir(), homedir(), homedir()])
  // Kept with no readers: a later one reads it at once, without probing again.
  const later = vi.fn()
  availability.subscribe(later)
  expect(later).toHaveBeenCalledWith(first.mock.calls[0][0])
  expect(mocks.observe).toHaveBeenCalledTimes(3)
})

it('recaptures for settings and uses the completed capture on Refresh', async () => {
  const { availability, change } = install()
  const read = vi.fn()
  availability.subscribe(read)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  change({ terminalFontSize: 14 })
  change({ agentCmdOverrides: { pi: '/opt/pi' } })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const capture = Promise.withResolvers<void>()
  let version: typeof READY | typeof TOO_OLD = TOO_OLD
  mocks.observe.mockImplementation(async () => version)
  mocks.recapture.mockImplementation(() => capture.promise)
  mocks.refreshed.forEach((listener) => listener())
  expect(mocks.recapture).toHaveBeenCalledTimes(2)
  change({ agentDefaultEnv: { pi: { PI_TEST: 'updated' } } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(read).toHaveBeenCalledTimes(2)
  expect(mocks.observe).toHaveBeenCalledTimes(9)
  version = READY
  capture.resolve()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  expect(read.mock.lastCall?.[0]).toContainEqual(opencodeAvailable)
})

it('captures fresh shell facts for a first subscriber even when Refresh had no listener', async () => {
  const capture = Promise.withResolvers<void>()
  let version: typeof READY | typeof TOO_OLD = TOO_OLD
  mocks.observe.mockImplementation(async () => version)
  mocks.recapture.mockImplementation(() => capture.promise)
  mocks.refreshed.forEach((listener) => listener())
  const { availability } = install()
  const read = vi.fn()
  availability.subscribe(read)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mocks.observe).not.toHaveBeenCalled()
  version = READY
  capture.resolve()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(read.mock.lastCall?.[0]).toContainEqual(opencodeAvailable)
})

it('reads a missing program as missing, a workspace-relative PATH as unknown, and re-reads after an install', async () => {
  mocks.installable = false
  mocks.programs.claude = found('claude', `bin${delimiter}/usr/bin`)
  const { availability } = install()
  const read = vi.fn()
  availability.subscribe(read)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const programOf = (agent: string) =>
    read.mock.lastCall?.[0].find((row: { agent: string }) => row.agent === agent)?.chatProgram
  expect(programOf('claude')).toBe('unknown')
  expect(programOf('opencode')).toBe('missing')
  mocks.programs.opencode = found('/data/runtimes/opencode/bin/opencode')
  mocks.releasesChanged.forEach((listener) => listener())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(programOf('opencode')).toBe('available')
})
