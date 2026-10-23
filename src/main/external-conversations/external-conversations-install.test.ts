import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime-core'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { installExternalConversations } from './external-conversations-install'
import {
  fakeLauncher,
  fakeLinkStore,
  fakeTerminal,
  launchResult,
  PANE,
  SESSION,
  sessionRow,
  WORKTREE
} from './external-conversation.test-fixture'

type SettingsListener = (updates: Partial<GlobalSettings>) => void

function fakeStore(initial: Partial<GlobalSettings>, records = fakeLinkStore()) {
  let settings = { ...initial }
  const listeners = new Set<SettingsListener>()
  const getSettings = vi.fn(() => settings)
  const store = {
    ...records.store,
    getSettings,
    onSettingsChanged: (listener: SettingsListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const update = (updates: Partial<GlobalSettings>): void => {
    settings = { ...settings, ...updates }
    listeners.forEach((listener) => listener(updates))
  }
  return { store, listeners, getSettings, update }
}

function runtime() {
  const db = new OrchestrationDb(':memory:')
  const lifecycle = new Set<(event: RuntimeWorktreeLifecycleEvent) => void>()
  return {
    lifecycle,
    getOrchestrationDb: vi.fn(() => db),
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => {
      lifecycle.add(listener)
      return () => {
        lifecycle.delete(listener)
      }
    },
    subscribeAgentProviderSessionChangesFn: null,
    getAgentStatusRowsForPane: (): AgentStatusIpcPayload[] => []
  }
}

describe('installExternalConversations', () => {
  it('builds nothing and opens nothing while connectors are off', () => {
    const { store, getSettings, update } = fakeStore({})
    const host = { ...runtime(), subscribeAgentProviderSessionChangesFn: vi.fn(() => () => {}) }
    const repos = vi.spyOn(store, 'getRepos')
    const meta = vi.spyOn(store, 'getAllWorktreeMetaForHost')
    const folders = vi.spyOn(store, 'getFolderWorkspaces')
    const rows = vi.spyOn(host, 'getAgentStatusRowsForPane')
    const connectors = installExternalConversations(store, host)
    // Nothing is read until the host's first `current()`.
    expect(getSettings).not.toHaveBeenCalled()
    expect(connectors.current()).toBeNull()
    update({ experimentalConnectors: false })
    expect(connectors.current()).toBeNull()
    expect(host.getOrchestrationDb).not.toHaveBeenCalled()
    expect(host.lifecycle.size).toBe(0)
    expect(host.subscribeAgentProviderSessionChangesFn).not.toHaveBeenCalled()
    expect(repos).not.toHaveBeenCalled()
    expect(meta).not.toHaveBeenCalled()
    expect(folders).not.toHaveBeenCalled()
    expect(rows).not.toHaveBeenCalled()
  })

  it('builds the seam on first use when the setting is already on', () => {
    const { store } = fakeStore({ experimentalConnectors: true })
    const seam = installExternalConversations(store, runtime()).current()
    expect(seam?.signal.aborted).toBe(false)
  })

  it('disposes on disable without another call, and builds one fresh seam on re-enable', () => {
    const { store, listeners, update } = fakeStore({ experimentalConnectors: true })
    const host = runtime()
    const connectors = installExternalConversations(store, host)
    const first = connectors.current()

    update({ experimentalConnectors: false })
    expect(first?.signal.reason).toBe('connectors_disabled')
    expect(host.lifecycle.size).toBe(0)
    expect(connectors.current()).toBeNull()

    update({ experimentalConnectors: true })
    const second = connectors.current()
    expect(second).not.toBe(first)
    expect(second?.signal.aborted).toBe(false)
    expect(listeners.size).toBe(1)
    expect(host.lifecycle.size).toBe(1)
  })

  it('leaves a delivery still running across a disable and re-enable to its owner', async () => {
    const { store, update } = fakeStore({ experimentalConnectors: true })
    const host = runtime()
    const db = host.getOrchestrationDb()
    const connectors = installExternalConversations(store, host)
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { launcher, launch } = fakeLauncher(async () => {
      await held
      return launchResult('handed-to-terminal')
    })
    const conversation = { launcher, terminal: fakeTerminal().terminal }
    const key = { source: 'dev', externalId: 'thread' } as const
    const input = {
      agent: 'claude',
      target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
      prompt: 'hi'
    }
    const live = connectors.current()?.start(conversation, key, 'd1', input)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))

    update({ experimentalConnectors: false })
    update({ experimentalConnectors: true })
    const retry = connectors.current()?.start(conversation, key, 'd1', input)
    const requestId = JSON.stringify(['thread', 'd1'])
    expect(db.getMutationReceipt('connector:dev', requestId)?.state).toBe('pending')

    release()
    const [first, second] = await Promise.all([live, retry])
    expect(second?.initial).toEqual(first?.initial)
    expect(db.getMutationReceipt('connector:dev', requestId)?.receipt).toBe(
      JSON.stringify(first?.initial)
    )
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('keeps the seam through unrelated settings changes', () => {
    const { store, update } = fakeStore({ experimentalConnectors: true })
    const connectors = installExternalConversations(store, runtime())
    const seam = connectors.current()
    update({ editorAutoSave: true })
    expect(connectors.current()).toBe(seam)
  })

  it('stays off without a store', () => {
    expect(installExternalConversations(null, runtime()).current()).toBeNull()
  })

  it('watches persisted links from host startup, so a session changed before any call is kept', () => {
    const records = fakeLinkStore()
    const link = { source: 'dev', externalId: 't1', paneKey: PANE, agent: 'claude' }
    records.put(WORKTREE, 'local', {
      externalConversations: [
        { ...link, providerSession: SESSION, captureHostId: 'local', createdAt: 1 }
      ]
    })
    const { store, update } = fakeStore({ experimentalConnectors: true }, records)
    let rows: AgentStatusIpcPayload[] = []
    const reports = new Set<(sessions: readonly { paneKey: string; sessionId: string }[]) => void>()
    const host = {
      ...runtime(),
      getAgentStatusRowsForPane: () => rows,
      subscribeAgentProviderSessionChangesFn: (
        listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
      ) => {
        reports.add(listener)
        return () => reports.delete(listener)
      }
    }
    // What each runtime host does at startup, before any connector call.
    const connectors = installExternalConversations(store, host)
    connectors.current()
    const cleared = { ...SESSION, id: 'claude-session-after-clear' }
    rows = [sessionRow(PANE, null, cleared)]
    reports.forEach((listener) => listener([{ paneKey: PANE, sessionId: cleared.id }]))
    rows = []
    expect(records.row(WORKTREE)?.externalConversations).toEqual([
      expect.objectContaining({ ...link, providerSession: cleared })
    ])
    update({ experimentalConnectors: false })
    expect(reports.size).toBe(0)
    const reenabled = { ...SESSION, id: 'claude-session-after-reenable' }
    rows = [sessionRow(PANE, null, reenabled)]
    update({ experimentalConnectors: true })
    expect(reports.size).toBe(1)
    expect(records.row(WORKTREE)?.externalConversations).toEqual([
      expect.objectContaining({ ...link, providerSession: reenabled })
    ])
    const later = { ...SESSION, id: 'claude-session-after-new-report' }
    rows = [sessionRow(PANE, null, later)]
    reports.forEach((listener) => listener([{ paneKey: PANE, sessionId: later.id }]))
    rows = []
    expect(records.row(WORKTREE)?.externalConversations).toEqual([
      expect.objectContaining({ ...link, providerSession: later })
    ])
  })
})
