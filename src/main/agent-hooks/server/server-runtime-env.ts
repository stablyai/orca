import { join } from 'node:path'
import {
  getEndpointFileName,
  readPublishedEndpoint,
  writeEndpointFile
} from '../../../shared/agent-hook-listener/endpoint-publication'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../../../shared/agent-hook-types'
import { AgentHookServerIngestRemote } from './server-ingest-remote'

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
    // Hooks read the endpoint on invocation; dev instances must not steal each other's hooks.
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get listeningPort(): number {
    return this.port
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

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
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    this.endpointFileWritten = ok
  }

  protected readReusableEndpoint(reuse: boolean): { port: number; token: string } | null {
    return reuse && this.endpointFilePathCache
      ? readPublishedEndpoint(this.endpointFilePathCache)
      : null
  }

  protected configureEndpointPaths(userDataPath: string, endpointNamespace?: string): void {
    // Dev endpoints are per instance; packaged endpoints stay stable for PTY reconnect.
    this.endpointDir = endpointNamespace
      ? join(userDataPath, 'agent-hooks', endpointNamespace)
      : join(userDataPath, 'agent-hooks')
    this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
    this.lastStatusFilePath = join(this.endpointDir, 'last-status.json')
  }
}
