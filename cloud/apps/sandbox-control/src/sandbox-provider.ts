// The provider calls the control plane needs, shaped after Vercel Sandbox's persistent-sandbox API.
// Lifecycle code depends only on this, so a second provider (Freestyle, E2B) is one more adapter.
import type { NetworkPolicy } from './network-policy'

export type ProviderSessionStatus =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'aborted'
  | 'snapshotting'

export type ProviderSandbox = {
  name: string
  status: ProviderSessionStatus
  currentSessionId: string
  currentSnapshotId: string | null
  tags: Record<string, string>
}

export type ProviderSession = {
  id: string
  status: ProviderSessionStatus
  startedAt: number | null
  /** Session timeout in ms, counted from start. */
  timeoutMs: number
}

export type ProviderRoute = { port: number; url: string }

export type ProviderSandboxState = {
  sandbox: ProviderSandbox
  session: ProviderSession
  routes: ProviderRoute[]
}

export type ProviderSnapshot = {
  id: string
  status: 'created' | 'deleted' | 'failed'
  sourceSessionId: string
}

export type CreateSandboxParams = {
  name: string
  snapshotId: string
  vcpus: number
  region: string
  timeoutMs: number
  ports: number[]
  networkPolicy: NetworkPolicy
  tags: Record<string, string>
}

export type RunCommandParams = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sudo?: boolean
  timeoutMs: number
}

export type CommandResult = { exitCode: number; stdout: string; stderr: string }

export type SandboxProviderApi = {
  createSandbox(params: CreateSandboxParams): Promise<ProviderSandboxState>
  /** `resume: true` boots a stopped persistent sandbox from its latest snapshot. Null when absent. */
  getSandbox(name: string, options: { resume: boolean }): Promise<ProviderSandboxState | null>
  stopSession(sessionId: string): Promise<{ snapshotId: string | null }>
  extendTimeout(sessionId: string, durationMs: number): Promise<ProviderSession>
  updateNetworkPolicy(sessionId: string, policy: NetworkPolicy): Promise<void>
  runCommand(sessionId: string, params: RunCommandParams): Promise<CommandResult>
  /** Resolves when already gone. */
  deleteSandbox(name: string): Promise<void>
  listSnapshots(name: string): Promise<ProviderSnapshot[]>
  /** Resolves when already gone. */
  deleteSnapshot(snapshotId: string): Promise<void>
}

/** Provider failed or answered unexpectedly; the body is never surfaced to callers. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null
  ) {
    super(`provider request failed (${status}${code ? ` ${code}` : ''})`)
    this.name = 'ProviderError'
  }
}
