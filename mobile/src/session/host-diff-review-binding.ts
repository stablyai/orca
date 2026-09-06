import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export type HostDiffReviewBinding = {
  client: RpcClient | null
  connectionState: ConnectionState
  reconnect(): Promise<void>
  device: HostDiffReviewDeviceOperations
}

export type HostDiffReviewDeviceOperations = {
  selection(): void
  success(): void
  error(): void
  writeClipboard(text: string): Promise<void>
  openExternal(url: string): Promise<void>
}
