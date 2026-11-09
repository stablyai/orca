// Provider calls only the operator-run golden image build needs (image/build-golden-image.ts).
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
}
