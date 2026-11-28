import { getTerminalInputByteLength } from '../../../../src/shared/terminal/input/terminal-input'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { RpcSendParams } from '../../../../src/shared/rpc-contract/rpc-send-params'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from '../live-input/terminal-live-input'

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
  waiters: number
  resolveOnFinish?: boolean
  options: TerminalInputEnqueueOptions
  cleanup: () => void
}
export type Batch = {
  params: Params
  options?: SendRequestOptions
  kind: 'text' | 'control' | 'gesture' | 'paste'
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

export function canMergeTerminalInputBatch(
  tail: Batch | undefined,
  params: Params,
  options: SendRequestOptions | undefined,
  kind: Batch['kind'],
  bytes: number
): tail is Batch {
  return Boolean(
    tail &&
    options === tail.options &&
    !options?.beforeSend &&
    kind !== 'control' &&
    kind !== 'paste' &&
    tail.kind === kind &&
    [tail.params, params].every((input) =>
      Object.keys(input).every((key) => ['terminal', 'text', 'enter', 'client'].includes(key))
    ) &&
    tail.params.client?.id === params.client?.id &&
    tail.params.client?.type === params.client?.type &&
    getTerminalInputByteLength(tail.params.text ?? '') + bytes <= TERMINAL_LIVE_INPUT_MAX_BYTES
  )
}

export function acquireTerminalInputOwner(
  owners: Map<string, Owner>,
  client: RpcClient,
  terminal: string,
  capable: boolean,
  fail: (owner: Owner) => void
): Owner | null {
  let owner = owners.get(terminal)
  if (owner && owner.epoch !== epoch(client)) {
    fail(owner)
    owners.delete(terminal)
    owner = undefined
  }
  if (owner?.failed) {
    if (owner.active.size || owner.opening) {
      return null
    }
    capable = owner.strict
    owners.delete(terminal)
    owner = undefined
  }
  if (!owner) {
    if (owners.size >= 64) {
      const idle = [...owners].find(
        ([, entry]) => !entry.active.size && !entry.pending.length && !entry.opening
      )
      if (!idle) {
        return null
      }
      owners.delete(idle[0])
    }
    owner = {
      client,
      handle: terminal,
      epoch: epoch(client),
      strict: capable,
      token: null,
      seq: 0,
      pending: [],
      active: new Set(),
      opening: false,
      failed: false
    }
    owners.set(terminal, owner)
  }
  return owner
}
