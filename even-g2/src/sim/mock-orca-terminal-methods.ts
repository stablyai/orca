// Unit 6: terminal.* RPC handlers for MockOrcaServer, split out of mock-orca-server.ts to keep
// that file under the line budget. Each handler receives the tiny `TerminalRpcContext` (response
// plumbing MockOrcaServer already owns) plus the shared MockTerminalRegistry.
import type { RuntimeTerminalAgentStatus } from '@orca-shared/runtime-terminal-contracts'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '@orca-shared/terminal-stream-protocol'
import type { RpcResponse, RpcSuccess } from '../transport/orca-rpc-wire'
import { encryptBytes } from './mock-orca-server-encryption'
import type { MemorySocketLike } from './memory-socket-pair'
import { MEMORY_SOCKET_READY_STATE } from './memory-socket-pair'
import type {
  ConnectionState,
  RpcRequestLike,
  TerminalSubscriptionState
} from './mock-orca-connection-state'
import { normalizeWorktreeSelector } from './mock-orca-connection-state'
import type { MockTerminalRegistry } from './mock-terminal-registry'
import {
  buildDataMessage,
  buildScrollbackControlMessage,
  buildSnapshotFrames,
  buildSubscribedControlMessage
} from './mock-terminal-stream-frames'

export type TerminalRpcContext = {
  respond(socket: MemorySocketLike, state: ConnectionState, response: RpcResponse): void
  sendEncryptedText(socket: MemorySocketLike, state: ConnectionState, message: unknown): void
  success(id: string, result: unknown, streaming?: true): RpcSuccess
  allocateStreamId(): number
}

export function pushTerminalFrame(
  socket: MemorySocketLike,
  state: ConnectionState,
  subscription: TerminalSubscriptionState,
  opcode: TerminalStreamOpcode,
  text: string
): void {
  if (socket.readyState !== MEMORY_SOCKET_READY_STATE.OPEN) {
    return
  }
  const payload = new TextEncoder().encode(text)
  const frame = encodeTerminalStreamFrame({
    opcode,
    streamId: subscription.streamId,
    seq: subscription.seq++,
    payload
  })
  socket.send(encryptBytes(frame, state.sharedKey))
}

/** Routes host-originated bytes to a subscriber per its negotiated mode: a binary Output frame
 *  when `capabilities.terminalBinaryStream===1` was negotiated, else a JSON `{type:'data'}` push
 *  under the original subscribe request's id (CRITICAL finding terminal-tail-state.ts:42 is
 *  precisely a client that requests JSON but only ever reads binary frames). */
export function publishTerminalOutput(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  subscription: TerminalSubscriptionState,
  text: string
): void {
  if (subscription.mode === 'binary') {
    pushTerminalFrame(socket, state, subscription, TerminalStreamOpcode.Output, text)
    return
  }
  ctx.sendEncryptedText(
    socket,
    state,
    ctx.success(subscription.requestId, buildDataMessage(text), true)
  )
}

export function handleTerminalList(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  registry: MockTerminalRegistry,
  request: RpcRequestLike
): void {
  const worktreeId = normalizeWorktreeSelector(request.params?.worktree)
  const terminals = registry.listSummaries(worktreeId)
  ctx.respond(
    socket,
    state,
    ctx.success(request.id, { terminals, totalCount: terminals.length, truncated: false })
  )
}

export function handleTerminalResolveActive(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  registry: MockTerminalRegistry,
  request: RpcRequestLike
): void {
  const worktreeId = normalizeWorktreeSelector(request.params?.worktree)
  const handle = worktreeId ? registry.resolveActive(worktreeId) : null
  ctx.respond(socket, state, ctx.success(request.id, { handle }))
}

/** CRITICAL finding #1: backs terminal.agentStatus, which agent-terminal-resolution.ts's
 *  resolveWaitingTerminalHandle uses instead of terminal.resolveActive (desktop focus) to find
 *  the worktree's unique terminal actually needing input. Real shape verified against
 *  RuntimeTerminalAgentStatus (src/shared/runtime-terminal-contracts.ts) — the import makes any
 *  drift between this mock and the real contract a compile error. */
export function handleTerminalAgentStatus(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  registry: MockTerminalRegistry,
  request: RpcRequestLike
): void {
  const terminalId = String(request.params?.terminal ?? '')
  const status = registry.agentStatusFor(terminalId)
  const agentStatus: RuntimeTerminalAgentStatus = {
    handle: terminalId,
    isRunningAgent: status !== null,
    status
  }
  ctx.respond(socket, state, ctx.success(request.id, { agentStatus }))
}

export function handleTerminalSend(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  registry: MockTerminalRegistry,
  request: RpcRequestLike
): void {
  const terminalId = String(request.params?.terminal ?? '')
  const text = String(request.params?.text ?? '')
  if (!registry.isWritable(terminalId)) {
    // Wire shape verified against terminal-send-method.ts: refused sends are a SUCCESSFUL RPC
    // with `send.accepted: false`, not an RpcFailure — a caller that only checks `response.ok`
    // treats a refusal as delivered (HIGH finding nav-ports.ts:42).
    ctx.respond(
      socket,
      state,
      ctx.success(request.id, {
        send: {
          handle: terminalId,
          accepted: false,
          bytesWritten: 0,
          refusedReason: 'not_writable'
        }
      })
    )
    return
  }
  registry.appendOutput(terminalId, text)
  const subscription = state.terminalSubscriptions.get(terminalId)
  if (subscription) {
    publishTerminalOutput(ctx, socket, state, subscription, text)
  }
  ctx.respond(
    socket,
    state,
    ctx.success(request.id, {
      send: { handle: terminalId, accepted: true, bytesWritten: text.length }
    })
  )
}

export function handleTerminalSubscribe(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  registry: MockTerminalRegistry,
  request: RpcRequestLike
): void {
  const terminalId = String(request.params?.terminal ?? 'term-wt1-1')
  const capabilities = request.params?.capabilities as { terminalBinaryStream?: number } | undefined
  const mode: TerminalSubscriptionState['mode'] =
    capabilities?.terminalBinaryStream === 1 ? 'binary' : 'json'
  const subscription: TerminalSubscriptionState = {
    streamId: ctx.allocateStreamId(),
    seq: 0,
    mode,
    requestId: request.id
  }
  state.terminalSubscriptions.set(terminalId, subscription)
  const scrollback = registry.getBuffer(terminalId)
  const lines = scrollback.length > 0 ? scrollback.split('\n') : []
  if (mode === 'binary') {
    ctx.respond(
      socket,
      state,
      ctx.success(request.id, buildSubscribedControlMessage(subscription.streamId, lines), true)
    )
    for (const frame of buildSnapshotFrames(scrollback)) {
      pushTerminalFrame(socket, state, subscription, frame.opcode, frame.text)
    }
    return
  }
  // JSON fallback (runTerminalJsonSubscription): the ONLY initial emit is `{type:'scrollback',
  // ...}` — there is no separate `{type:'subscribed'}` control message on this path.
  ctx.respond(socket, state, ctx.success(request.id, buildScrollbackControlMessage(lines), true))
}

export function handleTerminalUnsubscribe(
  ctx: TerminalRpcContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  request: RpcRequestLike
): void {
  const subscriptionId = String(request.params?.subscriptionId ?? '')
  const subscription = state.terminalSubscriptions.get(subscriptionId)
  state.terminalSubscriptions.delete(subscriptionId)
  if (subscription) {
    ctx.sendEncryptedText(socket, state, ctx.success(subscription.requestId, { type: 'end' }, true))
  }
  ctx.respond(socket, state, ctx.success(request.id, { unsubscribed: true }))
}
