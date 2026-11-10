// Provider calls the golden image build needs: the operator CLI (image/build-golden-image.ts) and the
// Worker's scheduled rotation (src/golden-images.ts).
import type { ProviderSandboxState } from './sandbox-provider'

export type GoldenImageProviderApi = {
  createBuildSandbox(params: {
    name: string
    /** Vercel Managed Image the build starts from (64 GB disk; the deprecated runtimes give 32 GB). */
    image: string
    vcpus: number
    region: string
    timeoutMs: number
    tags: Record<string, string>
  }): Promise<ProviderSandboxState>
  /** Stops the session; `expirationMs: 0` keeps the snapshot until deleted. */
  createSnapshot(sessionId: string, expirationMs: number): Promise<string>
  /** Deletes the sandbox but keeps snapshots it produced. */
  deleteBuildSandbox(name: string): Promise<void>
  /** Starts a command without waiting; poll it with getCommand (builds outlast one cron tick). */
  startCommand(
    sessionId: string,
    params: { command: string; args?: string[]; env?: Record<string, string>; timeoutMs: number }
  ): Promise<string>
  /** Null exit code while it runs; `wait` blocks (provider-side) until it ends. */
  getCommand(
    sessionId: string,
    commandId: string,
    /** `wait`: block until it exits (the only way the provider reports an exit code); `waitMs` caps that. */
    options?: { wait?: boolean; waitMs?: number }
  ): Promise<{ exitCode: number | null }>
  /**
   * The command's output as provider ndjson (`{"stream":"stdout"|"stderr","data":"..."}` lines), from
   * the first byte; follows live output until the command ends.
   */
  streamCommandLogs(sessionId: string, commandId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>
  getSnapshot(snapshotId: string): Promise<{ id: string; status: 'created' | 'deleted' | 'failed'; expiresAt: number | null } | null>
}
