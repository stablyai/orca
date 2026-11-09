import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_MCP_SYNC_METHOD,
  AgentMcpSyncResult,
  type McpSyncStatus
} from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import { applyMcpSyncResult, planMcpSync } from '../../../shared/agent-mcp-sync/mcp-sync-plan'
import { listEphemeralVmRuntimes } from '../../../shared/ephemeral-vm-runtime-store'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/runtime-environment-transport-routing'
import type { CloudMcpSyncPreferences } from '../../../shared/agent-mcp-sync/mcp-sync-preferences'
import { mcpEgressHostsOf } from '../../../shared/agent-mcp-sync/mcp-egress-hosts'
import { environmentHandleFromRecipeResult } from '../../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from '../../hosted-sandbox/hosted-sandbox-driver'
import { readLocalMcpConfig, type LocalMcpConfig } from './local-mcp-config-read'
import type { CloudMcpEgress } from './cloud-mcp-egress'

const SYNC_TIMEOUT_MS = 30_000

export type { CloudMcpSyncPreferences }

const DEFAULT_PREFERENCES: CloudMcpSyncPreferences = { autoSync: true, excluded: [] }

export type CloudMcpSyncDeps = {
  userDataPath: string
  broadcast: (status: McpSyncStatus) => void
  readLocal?: (repoPath: string | null) => Promise<LocalMcpConfig>
  call?: (environmentId: string, params: unknown) => Promise<unknown>
  /** Opens the sandbox's allowlist for synced remote servers; absent without a control plane. */
  egress?: CloudMcpEgress
  now?: () => number
}

export type CloudMcpSync = {
  isCloudEnvironment(environmentId: string): boolean
  getStatus(environmentId: string): Promise<McpSyncStatus | null>
  sync(environmentId: string, trigger: 'connect' | 'manual'): Promise<McpSyncStatus | null>
  getPreferences(): CloudMcpSyncPreferences
  setPreferences(next: Partial<CloudMcpSyncPreferences>): CloudMcpSyncPreferences
}

class RuntimeCallError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined
  ) {
    super(message)
  }
}

function errorCode(error: unknown): McpSyncStatus['error'] {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'method_not_found') {
    return 'host-outdated'
  }
  return /unavailable|timeout|unreachable/.test(code) ? 'host-unreachable' : 'failed'
}

/** Mirrors this computer's MCP servers into each Orca Cloud workspace's agent configs. */
export function createCloudMcpSync(deps: CloudMcpSyncDeps): CloudMcpSync {
  const preferencesPath = join(deps.userDataPath, 'cloud-mcp-sync.json')
  const statuses = new Map<string, McpSyncStatus>()
  const queues = new Map<string, Promise<unknown>>()
  const now = deps.now ?? Date.now
  const readLocal = deps.readLocal ?? ((repoPath) => readLocalMcpConfig(repoPath))
  const call =
    deps.call ??
    (async (environmentId: string, params: unknown) => {
      const response = await callRuntimeEnvironment(
        deps.userDataPath,
        environmentId,
        AGENT_MCP_SYNC_METHOD,
        params,
        SYNC_TIMEOUT_MS
      )
      if (response.ok) {
        return response.result
      }
      throw new RuntimeCallError(response.error.message, response.error.code)
    })

  let preferences: CloudMcpSyncPreferences | null = null
  function getPreferences(): CloudMcpSyncPreferences {
    if (!preferences) {
      try {
        const parsed = JSON.parse(
          readFileSync(preferencesPath, 'utf8')
        ) as Partial<CloudMcpSyncPreferences>
        preferences = {
          autoSync: parsed.autoSync !== false,
          excluded: Array.isArray(parsed.excluded)
            ? parsed.excluded.filter((key): key is string => typeof key === 'string')
            : []
        }
      } catch {
        preferences = { ...DEFAULT_PREFERENCES, excluded: [] }
      }
    }
    return preferences
  }

  function cloudRuntime(environmentId: string) {
    return listEphemeralVmRuntimes(deps.userDataPath).find(
      (runtime) =>
        runtime.runtimeEnvironmentId === environmentId && runtime.recipe?.provider === 'orca-cloud'
    )
  }

  function sandboxIdOf(environmentId: string): string | null {
    const runtime = cloudRuntime(environmentId)
    const handle = runtime?.recipeResult
      ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
      : null
    const sandboxId = handle?.driverState.sandboxId
    return typeof sandboxId === 'string' && sandboxId ? sandboxId : null
  }

  /** Before the host checks reachability, so a remote server's first call already gets through. */
  async function openEgress(environmentId: string, rows: McpSyncStatus['rows']): Promise<void> {
    const sandboxId = deps.egress ? sandboxIdOf(environmentId) : null
    if (!deps.egress || !sandboxId) {
      return
    }
    try {
      const { hosts, dropped } = await deps.egress.apply(sandboxId, mcpEgressHostsOf(rows))
      const over = dropped.length ? `, ${dropped.length} over the limit` : ''
      console.info(
        `[cloud-mcp-sync] ${environmentId}: sandbox allows ${hosts.length} extra hosts${over}`
      )
    } catch (error) {
      // The host still gets the servers; ones it can't reach show as unreachable.
      console.warn(
        `[cloud-mcp-sync] ${environmentId}: could not open egress (${error instanceof Error ? error.message : String(error)})`
      )
    }
  }

  async function plan(environmentId: string) {
    const runtime = cloudRuntime(environmentId)
    const local = await readLocal(runtime?.repoPath ?? null)
    return planMcpSync({
      servers: local.servers,
      excluded: new Set(getPreferences().excluded),
      repoServerNames: local.repoServerNames,
      homeDir: homedir()
    })
  }

  function publish(status: McpSyncStatus): McpSyncStatus {
    statuses.set(status.environmentId, status)
    deps.broadcast(status)
    return status
  }

  /** What a sync would send, before any host has answered. */
  async function preview(environmentId: string): Promise<McpSyncStatus> {
    const { rows } = await plan(environmentId)
    return {
      environmentId,
      autoSync: getPreferences().autoSync,
      running: false,
      lastSyncedAt: null,
      error: null,
      rows
    }
  }

  async function run(environmentId: string): Promise<McpSyncStatus> {
    const { params, rows } = await plan(environmentId)
    const previous = statuses.get(environmentId)
    publish({
      environmentId,
      autoSync: getPreferences().autoSync,
      running: true,
      lastSyncedAt: previous?.lastSyncedAt ?? null,
      error: null,
      rows: previous?.rows.length ? previous.rows : rows
    })
    try {
      await openEgress(environmentId, rows)
      const result = AgentMcpSyncResult.parse(await call(environmentId, params))
      const applied = applyMcpSyncResult(rows, result)
      const synced = applied.filter((row) => row.state === 'synced').length
      console.info(
        `[cloud-mcp-sync] ${environmentId}: ${synced} synced, ${applied.length - synced} skipped`
      )
      return publish({
        environmentId,
        autoSync: getPreferences().autoSync,
        running: false,
        lastSyncedAt: now(),
        error: null,
        rows: applied
      })
    } catch (error) {
      const code = errorCode(error)
      console.warn(`[cloud-mcp-sync] ${environmentId}: sync failed (${code})`)
      return publish({
        environmentId,
        autoSync: getPreferences().autoSync,
        running: false,
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        error: code,
        rows
      })
    }
  }

  return {
    isCloudEnvironment: (environmentId) => cloudRuntime(environmentId) !== undefined,
    async getStatus(environmentId) {
      if (!cloudRuntime(environmentId)) {
        return null
      }
      return statuses.get(environmentId) ?? preview(environmentId)
    },
    sync(environmentId, trigger) {
      if (!cloudRuntime(environmentId)) {
        return Promise.resolve(null)
      }
      if (trigger === 'connect' && !getPreferences().autoSync) {
        return Promise.resolve(statuses.get(environmentId) ?? null)
      }
      // One sync per workspace at a time; a click during an auto-sync runs after it.
      const next = (queues.get(environmentId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => run(environmentId))
      queues.set(environmentId, next)
      return next
    },
    getPreferences,
    setPreferences(next) {
      const merged: CloudMcpSyncPreferences = {
        autoSync: next.autoSync ?? getPreferences().autoSync,
        excluded: [...new Set(next.excluded ?? getPreferences().excluded)].sort()
      }
      writeFileAtomically(preferencesPath, `${JSON.stringify(merged, null, 2)}\n`)
      preferences = merged
      for (const status of statuses.values()) {
        publish({ ...status, autoSync: merged.autoSync })
      }
      return merged
    }
  }
}
