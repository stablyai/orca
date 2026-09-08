import type { RpcClient } from './rpc-client'

export type MobileConnectionPath = 'lan' | 'tailscale' | 'relay'

export type StableLogicalRpcClient = RpcClient & {
  migrateTo(
    session: RpcClient,
    path: MobileConnectionPath,
    timeoutMs?: number,
    // Checked after the replacement authenticates, before the swap — lets a racing
    // caller withdraw when another path won while this dial was in flight.
    shouldAbort?: () => boolean
  ): Promise<void>
  suspendActiveSession(): void
  getActivePath(): MobileConnectionPath
  // The path the user is waiting on while migration or scheduled recovery is active.
  getPendingPath(): MobileConnectionPath | null
  setRecoveryPath(path: MobileConnectionPath | null, attempt?: number): void
  setRecoveryAttempt(attempt: number): void
  // Latched when the desktop has repeatedly refused this device's relay credential.
  setPairingRejected(rejected: boolean): void
  isPairingRejected(): boolean
  // Latched when the relay named the desktop's own sign-out as the reason it is absent.
  setHostSignedOut(signedOut: boolean): void
  isHostSignedOut(): boolean
  // Recovery attempts share this signal so status-only changes rerender.
  onConnectionPathChange(listener: () => void): () => void
  getGeneration(): number
}
