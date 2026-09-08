import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export type HostSourceControlBinding = {
  client: RpcClient | null
  connectionState: ConnectionState
  reconnect(): Promise<void>
  openExternalUrl(url: string): Promise<void>
  writeClipboard(text: string): Promise<void>
  feedback: HostSourceControlFeedback
}

export type HostSourceControlFeedback = {
  selection(): void
  success(): void
  error(): void
}
