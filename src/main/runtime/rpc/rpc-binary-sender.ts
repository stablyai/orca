export type RpcBinarySendOptions = {
  // Why: a lossy stream resends its newest frame later, so queueing stale frames behind a backlog only delays it.
  dropWhenBacklogged?: boolean
}

/** False: not sent or queued. 'backlogged': skipped under dropWhenBacklogged; the socket is alive. */
export type RpcBinarySendResult = boolean | void | 'backlogged'

export type RpcBinarySender = (
  bytes: Uint8Array<ArrayBufferLike>,
  options?: RpcBinarySendOptions
) => RpcBinarySendResult
