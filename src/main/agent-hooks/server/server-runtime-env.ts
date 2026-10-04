import { join } from 'node:path'
import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../../../shared/agent-hook-listener/endpoint-publication'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../../../shared/agent-hook-types'
import { AgentHookServerIngestRemote } from './server-ingest-remote'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerRuntimeEnv extends AgentHookServerIngestRemote {
  buildPtyEnv(): Record<string, string> {
    if (!this.statusHooksEnabled || this.port <= 0 || !this.token) {
      return {}
    }
    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION,
      ORCA_AGENT_HOOK_OPENCODE_TUI: '1',
      ORCA_AGENT_HOOK_TRANSPORT: ORCA_HOOK_RAW_JSON_TRANSPORT
    }
    // Why: hooks source this file at invocation; dev namespaces it so parallel `pnpm dev` runs don't steal each other's hooks.
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  /** Test/diagnostic accessor for the on-disk last-status file path. */
  get lastStatusPath(): string | null {
    return this.lastStatusFilePath
  }

  protected maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      openCodeTui: true,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT,
      contextPressureEnabled: this.contextPressureEnabled
    })
    this.endpointFileWritten = ok
  }

  setContextPressureEnabled(enabled: boolean): void {
    if (this.contextPressureEnabled === enabled) {
      return
    }
    this.contextPressureEnabled = enabled
    this.maybeWriteEndpointFile()
    if (enabled) {
      return
    }
    let changed = false
    for (const entry of this.state.lastStatusByPaneKey.values()) {
      // == null: rows already explicitly cleared need no re-emit/re-persist on toggle-off.
      if (entry.providerSessionOnly || entry.payload.contextUsage == null) {
        continue
      }
      const enriched = entry as EnrichedAgentHookEventPayload
      const updated: EnrichedAgentHookEventPayload = {
        ...enriched,
        payload: { ...enriched.payload, contextUsage: null }
      }
      admitLegacyAgentStatus(
        this.state,
        'main-context-pressure-disable',
        updated,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
      this.emitEnrichedStatus(updated)
      changed = true
    }
    if (changed) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  protected configureEndpointPaths(userDataPath: string, endpointNamespace?: string): void {
    // Why: dev builds share one userData path; namespace per instance while packaged keeps the stable path for PTY reconnect.
    this.endpointDir = endpointNamespace
      ? join(userDataPath, 'agent-hooks', endpointNamespace)
      : join(userDataPath, 'agent-hooks')
    this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
    this.lastStatusFilePath = join(this.endpointDir, 'last-status.json')
  }
}
