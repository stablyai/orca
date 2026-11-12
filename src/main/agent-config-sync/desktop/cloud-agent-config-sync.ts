import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_CONFIG_OPT_IN_KINDS,
  AgentConfigItemKind,
  type AgentConfigSyncStatus,
  type CloudAgentConfigSyncPreferences
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { listEphemeralVmRuntimes } from '../../../shared/ephemeral-vm-runtime-store'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/runtime-environment-transport-routing'
import { defaultAgentConfigHomes } from '../agent-config-roots'
import { applyAgentConfigSyncResults, planAgentConfigSync } from './agent-config-sync-plan'
import { exchangeAgentConfig } from './agent-config-host-exchange'
import { readLocalAgentConfig, type LocalAgentConfigItem } from './local-agent-config-read'
import { readOrCreateSyncerId } from './syncer-id'
import {
  DEFAULT_PREFERENCES,
  MAX_EXCLUDED,
  RuntimeCallError,
  errorCode,
  parsePreferences,
  trackedAgentConfigPaths
} from './cloud-agent-config-sync-support'

export type CloudAgentConfigSyncDeps = {
  userDataPath: string
  broadcast: (status: AgentConfigSyncStatus) => void
  broadcastPreferences?: (preferences: CloudAgentConfigSyncPreferences) => void
  readLocal?: (repoPath: string | null) => Promise<LocalAgentConfigItem[]>
  call?: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<unknown>
  now?: () => number
}

export type CloudAgentConfigSync = {
  isCloudEnvironment(environmentId: string): boolean
  getStatus(environmentId: string): Promise<AgentConfigSyncStatus | null>
  sync(environmentId: string, trigger: 'connect' | 'manual'): Promise<AgentConfigSyncStatus | null>
  /** Settles once saved preferences are read; getPreferences answers defaults until then. */
  ready: Promise<void>
  getPreferences(): CloudAgentConfigSyncPreferences
  setPreferences(next: Partial<CloudAgentConfigSyncPreferences>): CloudAgentConfigSyncPreferences
  setItemIncluded(key: string, included: boolean): CloudAgentConfigSyncPreferences
}

/** Mirrors this computer's skills and slash commands into each Orca Cloud workspace. */
export function createCloudAgentConfigSync(deps: CloudAgentConfigSyncDeps): CloudAgentConfigSync {
  const preferencesPath = join(deps.userDataPath, 'cloud-agent-config-sync.json')
  const statuses = new Map<string, AgentConfigSyncStatus>()
  const queues = new Map<string, Promise<unknown>>()
  const now = deps.now ?? Date.now
  const readLocal =
    deps.readLocal ??
    ((repoPath) =>
      readLocalAgentConfig({
        homes: defaultAgentConfigHomes(),
        repoPath,
        trackedPaths: trackedAgentConfigPaths
      }))
  const call =
    deps.call ??
    (async (environmentId: string, method: string, params: unknown, timeoutMs: number) => {
      const response = await callRuntimeEnvironment(
        deps.userDataPath,
        environmentId,
        method,
        params,
        timeoutMs
      )
      if (response.ok) {
        return response.result
      }
      throw new RuntimeCallError(response.error.message, response.error.code)
    })

  let preferences: CloudAgentConfigSyncPreferences | null = null
  const ready = readFile(preferencesPath, 'utf8')
    .then(parsePreferences)
    .catch(() => null)
    .then((loaded) => {
      // A change saved while this read ran wins.
      preferences ??= loaded ?? { ...DEFAULT_PREFERENCES, excluded: [], optedIn: [] }
    })
  function getPreferences(): CloudAgentConfigSyncPreferences {
    return preferences ?? { ...DEFAULT_PREFERENCES, excluded: [], optedIn: [] }
  }

  function cloudRuntime(environmentId: string) {
    return listEphemeralVmRuntimes(deps.userDataPath).find(
      (runtime) =>
        runtime.runtimeEnvironmentId === environmentId && runtime.recipe?.provider === 'orca-cloud'
    )
  }

  async function plan(environmentId: string) {
    const local = await readLocal(cloudRuntime(environmentId)?.repoPath ?? null)
    const prefs = getPreferences()
    return planAgentConfigSync({
      items: local,
      excluded: new Set(prefs.excluded),
      optedIn: new Set(prefs.optedIn),
      shareAcrossAgents: prefs.shareAcrossAgents
    })
  }

  function publish(status: AgentConfigSyncStatus): AgentConfigSyncStatus {
    statuses.set(status.environmentId, status)
    deps.broadcast(status)
    return status
  }

  async function run(environmentId: string): Promise<AgentConfigSyncStatus> {
    const previous = statuses.get(environmentId)
    const planned = await plan(environmentId).catch(() => null)
    if (!planned) {
      return publish({
        environmentId,
        running: false,
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        error: 'failed',
        rows: previous?.rows ?? []
      })
    }
    publish({
      environmentId,
      running: true,
      lastSyncedAt: previous?.lastSyncedAt ?? null,
      error: previous?.error ?? null,
      rows: previous?.rows.length ? previous.rows : planned.rows
    })
    const syncer = await readOrCreateSyncerId(deps.userDataPath)
    try {
      const exchange = await exchangeAgentConfig(call, environmentId, syncer, planned.desired)
      const hostPlan = exchange.plan
      const rows = applyAgentConfigSyncResults(planned.rows, hostPlan, exchange.put).map((row) =>
        exchange.outdatedKeys.has(row.key)
          ? { ...row, state: 'skipped' as const, skipReason: 'host-outdated' as const }
          : row
      )
      const synced = rows.filter((row) => row.state === 'synced').length
      console.info(
        `[cloud-agent-config-sync] ${environmentId}: ${synced} synced, ${exchange.sent} sent, ${hostPlan.removed} removed, ${rows.length - synced} not synced`
      )
      return publish({ environmentId, running: false, lastSyncedAt: now(), error: null, rows })
    } catch (error) {
      const code = errorCode(error)
      console.warn(`[cloud-agent-config-sync] ${environmentId}: sync failed (${code})`)
      return publish({
        environmentId,
        running: false,
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        error: code,
        rows: planned.rows
      })
    }
  }

  function enqueue(environmentId: string): Promise<AgentConfigSyncStatus> {
    // One sync per workspace at a time; a click during an auto-sync runs after it.
    const next = (queues.get(environmentId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => run(environmentId))
    queues.set(environmentId, next)
    void next.finally(() => {
      if (queues.get(environmentId) === next) {
        queues.delete(environmentId)
      }
    })
    return next
  }

  /** After a settings change, bring every workspace that already synced in line with it. */
  function resyncSynced(): void {
    for (const status of statuses.values()) {
      if (status.lastSyncedAt !== null && cloudRuntime(status.environmentId)) {
        void enqueue(status.environmentId).catch(() => {})
      }
    }
  }

  function setPreferences(
    next: Partial<CloudAgentConfigSyncPreferences>
  ): CloudAgentConfigSyncPreferences {
    const current = getPreferences()
    const merged: CloudAgentConfigSyncPreferences = {
      autoSync: next.autoSync ?? current.autoSync,
      shareAcrossAgents: next.shareAcrossAgents ?? current.shareAcrossAgents,
      excluded: [...new Set(next.excluded ?? current.excluded)].sort().slice(0, MAX_EXCLUDED),
      optedIn: [...new Set(next.optedIn ?? current.optedIn)].sort().slice(0, MAX_EXCLUDED)
    }
    writeFileAtomically(preferencesPath, `${JSON.stringify(merged, null, 2)}\n`)
    preferences = merged
    deps.broadcastPreferences?.(merged)
    return merged
  }

  return {
    ready,
    isCloudEnvironment: (environmentId) => cloudRuntime(environmentId) !== undefined,
    async getStatus(environmentId) {
      await ready
      if (!cloudRuntime(environmentId)) {
        return null
      }
      const known = statuses.get(environmentId)
      if (known) {
        return known
      }
      // Before any sync: what would go, read from this computer only.
      const planned = await plan(environmentId).catch(() => null)
      return {
        environmentId,
        running: false,
        lastSyncedAt: null,
        error: planned ? null : 'failed',
        rows: planned?.rows ?? []
      }
    },
    async sync(environmentId, trigger) {
      await ready
      if (!cloudRuntime(environmentId)) {
        return null
      }
      if (trigger === 'connect' && !getPreferences().autoSync) {
        return statuses.get(environmentId) ?? null
      }
      return enqueue(environmentId)
    },
    getPreferences,
    setPreferences(next) {
      const before = getPreferences()
      const merged = setPreferences(next)
      // Turning sync on reaches the running workspaces now, not at their next wake.
      if (merged.autoSync && !before.autoSync) {
        for (const runtime of listEphemeralVmRuntimes(deps.userDataPath)) {
          if (
            runtime.recipe?.provider === 'orca-cloud' &&
            runtime.status === 'running' &&
            runtime.runtimeEnvironmentId
          ) {
            void enqueue(runtime.runtimeEnvironmentId).catch(() => {})
          }
        }
      } else if (merged.shareAcrossAgents !== before.shareAcrossAgents) {
        resyncSynced()
      }
      return merged
    },
    setItemIncluded(key, included) {
      // Memory is opt-in: its switch lives in optedIn; every other item's in excluded.
      const kind = AgentConfigItemKind.safeParse(key.split(':')[1])
      const optIn = kind.success && AGENT_CONFIG_OPT_IN_KINDS.has(kind.data)
      const set = new Set(optIn ? getPreferences().optedIn : getPreferences().excluded)
      if (included === optIn) {
        set.add(key)
      } else {
        set.delete(key)
      }
      const merged = setPreferences(optIn ? { optedIn: [...set] } : { excluded: [...set] })
      resyncSynced()
      return merged
    }
  }
}
