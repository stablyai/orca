import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadAgentAwakeService } from './orcad-agent-awake'
import type { AgentAwakeStatus } from '../power/agent-awake-status-lease'
import type { AgentHookStatusChangeEntry } from '../agent-hooks/server/server-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'

function workingEntry(overrides: Partial<AgentHookStatusChangeEntry> = {}): AgentAwakeStatus {
  return {
    paneKey: 'pane-1',
    state: 'working',
    receivedAt: Date.now(),
    observedInCurrentRuntime: true,
    ...overrides
  }
}

function createStore(initial: Partial<GlobalSettings> = {}) {
  const listeners = new Set<(updates: Partial<GlobalSettings>, settings: GlobalSettings) => void>()
  let settings: GlobalSettings
  const store = {
    getSettings: () => settings,
    onSettingsChanged: vi.fn(
      (listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    ),
    applyUpdates(updates: Partial<GlobalSettings>) {
      settings = { ...settings, ...updates }
      for (const listener of listeners) {
        listener(updates, settings)
      }
    }
  }
  // Only the two fields the service reads matter; the rest of GlobalSettings
  // is never touched, so a minimal object satisfies the Pick contract.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service only reads computerAwakeMode/keepComputerAwakeWhileAgentsRun; remaining fields are never dereferenced.
  settings = {
    computerAwakeMode: 'off',
    keepComputerAwakeWhileAgentsRun: false,
    ...initial
  } as GlobalSettings
  return store
}

function createHookServer(initial: AgentHookStatusChangeEntry[] = []) {
  const changeListeners = new Set<(statuses: AgentHookStatusChangeEntry[]) => void>()
  const freshnessListeners = new Set<(status: AgentHookStatusChangeEntry) => void>()
  let snapshot = initial
  return {
    subscribeStatusChanges: vi.fn((listener: (statuses: AgentHookStatusChangeEntry[]) => void) => {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    }),
    subscribeStatusFreshness: vi.fn((listener: (status: AgentHookStatusChangeEntry) => void) => {
      freshnessListeners.add(listener)
      return () => freshnessListeners.delete(listener)
    }),
    getStatusChangeSnapshot: vi.fn(() => snapshot),
    push(statuses: AgentHookStatusChangeEntry[]) {
      snapshot = statuses
      for (const listener of changeListeners) {
        listener(statuses)
      }
    },
    renew(status: AgentHookStatusChangeEntry) {
      for (const listener of freshnessListeners) {
        listener(status)
      }
    }
  }
}

describe('OrcadAgentAwakeService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports mode off with no active blocker by default', () => {
    const store = createStore()
    const service = new OrcadAgentAwakeService(store, createHookServer())
    service.start()
    expect(service.getStatus()).toEqual({ mode: 'off', active: false })
    service.dispose()
  })

  it('activates in on mode regardless of agent status', () => {
    const store = createStore({ computerAwakeMode: 'on', keepComputerAwakeWhileAgentsRun: true })
    const service = new OrcadAgentAwakeService(store, createHookServer())
    service.start()
    expect(service.getStatus()).toEqual({ mode: 'on', active: true })
    service.dispose()
  })

  it('activates in auto mode only while a working agent is observed', () => {
    const store = createStore({ computerAwakeMode: 'auto', keepComputerAwakeWhileAgentsRun: true })
    const hookServer = createHookServer()
    const service = new OrcadAgentAwakeService(store, hookServer)
    service.start()
    expect(service.getStatus().active).toBe(false)

    hookServer.push([workingEntry()])
    expect(service.getStatus().active).toBe(true)

    hookServer.push([workingEntry({ state: 'done' })])
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('ignores statuses not observed in the current runtime', () => {
    const store = createStore({ computerAwakeMode: 'auto', keepComputerAwakeWhileAgentsRun: true })
    const hookServer = createHookServer()
    const service = new OrcadAgentAwakeService(store, hookServer)
    service.start()
    hookServer.push([workingEntry({ observedInCurrentRuntime: false })])
    expect(service.getStatus().active).toBe(false)
    service.dispose()
  })

  it('falls back to the legacy flag when no explicit mode is set', () => {
    const store = createStore({
      computerAwakeMode: undefined,
      keepComputerAwakeWhileAgentsRun: true
    })
    const service = new OrcadAgentAwakeService(store, createHookServer())
    service.start()
    expect(service.getStatus()).toEqual({ mode: 'auto', active: false })
    service.dispose()
  })

  it('seeds the snapshot so a status observed before start still counts', () => {
    const store = createStore({ computerAwakeMode: 'auto', keepComputerAwakeWhileAgentsRun: true })
    const hookServer = createHookServer([workingEntry()])
    const service = new OrcadAgentAwakeService(store, hookServer)
    service.start()
    expect(service.getStatus().active).toBe(true)
    service.dispose()
  })

  it('publishes only on mode/active transitions', () => {
    const store = createStore({ computerAwakeMode: 'auto', keepComputerAwakeWhileAgentsRun: true })
    const hookServer = createHookServer()
    const service = new OrcadAgentAwakeService(store, hookServer)
    const listener = vi.fn()
    service.subscribe(listener)
    service.start()
    // First publish: off → false
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ mode: 'auto', active: false })

    hookServer.push([workingEntry()])
    expect(listener).toHaveBeenLastCalledWith({ mode: 'auto', active: true })
    expect(listener).toHaveBeenCalledTimes(2)

    // A second identical push does not republish.
    hookServer.push([workingEntry()])
    expect(listener).toHaveBeenCalledTimes(2)

    store.applyUpdates({ computerAwakeMode: 'off', keepComputerAwakeWhileAgentsRun: false })
    expect(listener).toHaveBeenLastCalledWith({ mode: 'off', active: false })
    expect(listener).toHaveBeenCalledTimes(3)
    service.dispose()
  })

  it('expires stale statuses on the lease timer', () => {
    vi.useFakeTimers()
    try {
      const store = createStore({
        computerAwakeMode: 'auto',
        keepComputerAwakeWhileAgentsRun: true
      })
      const hookServer = createHookServer()
      const service = new OrcadAgentAwakeService(store, hookServer)
      service.start()
      hookServer.push([workingEntry({ receivedAt: Date.now() })])
      expect(service.getStatus().active).toBe(true)
      // AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2h
      vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1)
      expect(service.getStatus().active).toBe(false)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
