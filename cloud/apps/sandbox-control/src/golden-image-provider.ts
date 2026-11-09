// Provider calls the golden image build needs: the operator CLI (image/build-golden-image.ts) and the
// Worker's scheduled rotation (src/golden-images.ts).
import type { ProviderSandboxState } from './sandbox-provider'

export type GoldenImageProviderApi = {
  createBuildSandbox(params: {
    name: string
    runtime: string
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
  /** Null exit code while it runs. */
  getCommand(sessionId: string, commandId: string): Promise<{ exitCode: number | null }>
  getSnapshot(snapshotId: string): Promise<{ id: string; status: 'created' | 'deleted' | 'failed'; expiresAt: number | null } | null>
}
