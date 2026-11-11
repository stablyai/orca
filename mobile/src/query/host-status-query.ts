import {
  hostStatusProbe,
  readProbedHostStatus
} from '../transport/connection/host-status-probe-operations'
import type { HostStatusReply } from '../transport/hosts/host-status-reply-schema'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type {
  SendRequestOptions,
  UnvalidatedRpcRequestPort
} from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

import { readViewBase } from './host-read-client'

export type HostStatusClient = UnvalidatedRpcRequestPort &
  Partial<Pick<RpcClient, 'getState' | 'getGeneration' | 'getLastConnectedAt' | 'requestRoute'>>

type LandedStatus = { reply: RpcResponse; status: HostStatusReply }
type ConnectionStatus = { epoch: string; landed?: LandedStatus; pending?: Promise<RpcResponse> }

// Keyed by client, so each JS world (native heap, each page document) holds its own.
const statuses = new WeakMap<object, ConnectionStatus>()

export const hostConnectionEpoch = (
  client: Pick<HostStatusClient, 'getGeneration' | 'getLastConnectedAt'>
) => `${client.getGeneration?.()}:${client.getLastConnectedAt?.()}`

// Why: a routed view answers status.get from a server behind the desktop, which can restart or reconnect while
// this connection stays up, and a client with no connect time has no epoch to hold an answer to.
export function directConnectionEpoch(client: HostStatusClient): string | null {
  return client.requestRoute === undefined && typeof client.getLastConnectedAt?.() === 'number'
    ? hostConnectionEpoch(client)
    : null
}

const decodedReplies = new WeakMap<RpcResponse, ReturnType<typeof readProbedHostStatus>>()

/** Decodes a status.get reply once; decoding reports salvaged fields, and joined readers share one reply. */
export function decodeHostStatusReply(reply: RpcResponse): ReturnType<typeof readProbedHostStatus> {
  if (decodedReplies.has(reply)) {
    return decodedReplies.get(reply) ?? null
  }
  const decoded = readProbedHostStatus(reply)
  decodedReplies.set(reply, decoded)
  return decoded
}

// Keep each caller's own call shape: recordings pin the arguments a read was sent with.
function sendStatusGet(client: HostStatusClient, options: SendRequestOptions | undefined) {
  return options
    ? hostStatusProbe.request(client, undefined, options)
    : hostStatusProbe.request(client)
}

// The live direct connection that answers this client's status.get, or null when none may hold an answer.
// status.get carries no params, so a view that routes by params sends it where its base client would.
function statusConnection(
  view: HostStatusClient
): { connection: HostStatusClient; epoch: string } | null {
  // A query's read view shares its connection's status; it still sends through the view.
  const client = readViewBase(view)
  const route = client.requestRoute?.(undefined)
  if (route) {
    return route.intermediary || route.client === client ? null : statusConnection(route.client)
  }
  const epoch = client.getState?.() === 'connected' ? directConnectionEpoch(client) : null
  return epoch === null ? null : { connection: client, epoch }
}

/** The status this connection already received; undefined when it has none or may not reuse one. */
export function connectionHostStatus(client: HostStatusClient): LandedStatus | undefined {
  const live = statusConnection(client)
  if (!live) {
    return undefined
  }
  const entry = statuses.get(live.connection)
  return entry?.epoch === live.epoch ? entry.landed : undefined
}

/** Sends status.get, joining one already out on this connection; a readable answer becomes the connection's status. */
export function sendHostStatusRead(
  client: HostStatusClient,
  options?: SendRequestOptions
): Promise<RpcResponse> {
  const live = statusConnection(client)
  if (!live) {
    return sendStatusGet(client, options)
  }
  const { connection, epoch } = live
  let entry = statuses.get(connection)
  if (entry?.epoch !== epoch) {
    entry = { epoch }
    statuses.set(connection, entry)
  }
  if (entry.pending) {
    return entry.pending
  }
  const owner = entry
  // Other readers join this send, so one reader's abort or fence must not fail theirs; it is a read, so sending is safe.
  const { signal: _signal, beforeSend: _beforeSend, ...shared } = options ?? {}
  const pending = sendStatusGet(client, options && shared).then((reply) => {
    const status = decodeHostStatusReply(reply)?.status
    const now = statusConnection(client)
    if (status && now?.connection === connection && now.epoch === epoch) {
      owner.landed = { reply, status }
    }
    return reply
  })
  owner.pending = pending
  const settle = () => {
    if (owner.pending === pending) {
      owner.pending = undefined
    }
  }
  void pending.then(settle, settle)
  return pending
}

/**
 * The connection's status, read at most once per connection. Only for fields fixed for the desktop process's life
 * (protocol window, non-browser capabilities, platform, runtime id); a restart is a new connection. Live fields
 * (screencast capability, floating workspace flag, Windows shell) need a fresh read: the host gate reads on every mount.
 */
export function readHostStatusReply(
  client: HostStatusClient,
  options?: SendRequestOptions
): Promise<RpcResponse> {
  const landed = connectionHostStatus(client)
  return landed ? Promise.resolve(landed.reply) : sendHostStatusRead(client, options)
}

/**
 * A status.get operation whose requests take the connection's status instead of sending their own.
 * `live` readers need a field the desktop can change while connected, so they only join a read already out.
 */
export function connectionHostStatusRead<Verdict>(
  read: { operation: { method: 'status.get' }; interpret: (reply: RpcResponse) => Verdict },
  reuse: 'landed' | 'live' = 'landed'
) {
  const send = reuse === 'live' ? sendHostStatusRead : readHostStatusReply
  return Object.freeze({
    interpret: read.interpret,
    request: (client: HostStatusClient, _params?: undefined, options?: SendRequestOptions) =>
      send(client, options)
  })
}
