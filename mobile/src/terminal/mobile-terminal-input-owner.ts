import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { RpcResponse } from '../transport/types'

export type TerminalInputEnqueueOptions = {
  onAdmission?: (accepted: boolean) => void
  signal?: AbortSignal
  control?: boolean
  gestureDeadline?: number
  isCurrent?: () => boolean
}
export type Params = RpcSendParams<'terminal.send'>
export type Caller = {
  resolve: (reply: RpcResponse) => void
  bytes: number
  options: TerminalInputEnqueueOptions
  cleanup: () => void
}
export type Batch = {
  params: Params
  options?: SendRequestOptions
  kind: 'text' | 'control' | 'gesture'
  deadline?: number
  callers: Caller[]
}
export type Owner = {
  client: RpcClient
  handle: string
  epoch: string
  strict: boolean
  token: string | null
  seq: number
  pending: Batch[]
  active: Set<Batch>
  opening: boolean
  failed: boolean
}
export const refused = (terminal: string): RpcResponse => ({
  id: 'terminal-input-retired',
  ok: true,
  result: { send: { handle: terminal, accepted: false, bytesWritten: 0 } }
})
export const epoch = (client: RpcClient) =>
  `${client.getGeneration?.() ?? 0}:${client.getLastConnectedAt() ?? 0}`
