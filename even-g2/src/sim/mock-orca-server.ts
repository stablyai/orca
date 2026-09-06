// Unit 6: mock Orca desktop server speaking the real E2EE handshake (spec S6) over a
// memory-socket-pair. Deliberately independent of Unit 3 — uses tweetnacl directly
// (nacl.box.keyPair / before / after / open.after) with atob/btoa framing, matching the wire
// bytes mobile/src/transport/e2ee.ts produces, so a converged Unit 8 can swap this for the real
// glasses-e2ee.ts module without changing wire behavior.
import nacl from 'tweetnacl'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/orca-rpc-wire'
import {
  base64ToBytes,
  bytesToBase64,
  decryptText,
  encryptText
} from './mock-orca-server-encryption'
import type { MemorySocketLike } from './memory-socket-pair'
import { MEMORY_SOCKET_READY_STATE } from './memory-socket-pair'
import {
  createFixtureNotifications,
  createFixtureWorktrees,
  FIXTURE_TERMINAL_SCROLLBACK,
  type FixtureNotificationEvent,
  type FixtureWorktreeStatus
} from './mock-orca-fixtures'
import { MockTerminalRegistry } from './mock-terminal-registry'
import type { ConnectionState, RpcRequestLike } from './mock-orca-connection-state'
import {
  handleTerminalAgentStatus,
  handleTerminalList,
  handleTerminalResolveActive,
  handleTerminalSend,
  handleTerminalSubscribe,
  handleTerminalUnsubscribe,
  publishTerminalOutput,
  type TerminalRpcContext
} from './mock-orca-terminal-methods'

const DEFAULT_DEVICE_TOKEN = 'mock-device-token'
const DEFAULT_RUNTIME_ID = 'mock-g2-runtime'

export type MockOrcaServerOptions = {
  deviceToken?: string
  runtimeId?: string
}

/** Real E2EE handshake + fixture RPC handlers (spec S6). One instance can serve multiple
 *  attached memory-socket connections, mirroring a real desktop with several clients. */
export class MockOrcaServer {
  readonly publicKeyB64: string
  /** Extra delay (ms) applied before every RPC response — scenario control for "slow rpc". */
  delayMs = 0
  /** Test-only observability hook: fires for every RPC request this server receives. */
  onRequestForTest: ((method: string, params: Record<string, unknown> | undefined) => void) | null =
    null

  private readonly keyPair = nacl.box.keyPair()
  private readonly deviceToken: string
  private readonly runtimeId: string
  private readonly connections = new Map<MemorySocketLike, ConnectionState>()
  private readonly worktrees = createFixtureWorktrees()
  private readonly terminals = new MockTerminalRegistry(FIXTURE_TERMINAL_SCROLLBACK, this.worktrees)
  private nextStreamId = 1
  private rejectNextAuth = false
  private readonly terminalRpc: TerminalRpcContext = {
    respond: (socket, state, response) => this.respond(socket, state, response),
    sendEncryptedText: (socket, state, message) => this.sendEncryptedText(socket, state, message),
    success: (id, result, streaming) => this.success(id, result, streaming),
    allocateStreamId: () => this.nextStreamId++
  }

  constructor(options?: MockOrcaServerOptions) {
    this.deviceToken = options?.deviceToken ?? DEFAULT_DEVICE_TOKEN
    this.runtimeId = options?.runtimeId ?? DEFAULT_RUNTIME_ID
    this.publicKeyB64 = bytesToBase64(this.keyPair.publicKey)
  }

  /** Wires a server-side memory socket into the handshake/RPC pipeline. Returns a detach fn. */
  attach(socket: MemorySocketLike): () => void {
    socket.onmessage = (event) => this.handleMessage(socket, event.data)
    socket.onclose = () => this.connections.delete(socket)
    return () => {
      socket.onmessage = null
      socket.onclose = null
      this.connections.delete(socket)
    }
  }

  // ---- scenario controls (spec S6) -------------------------------------------------------

  pushNotification(event: FixtureNotificationEvent): void {
    for (const [socket, state] of this.connections) {
      if (
        state.notificationSubscriptionId &&
        socket.readyState === MEMORY_SOCKET_READY_STATE.OPEN
      ) {
        this.sendEncryptedText(
          socket,
          state,
          this.success(state.notificationSubscriptionId, event, true)
        )
      }
    }
  }

  setWorktreeStatus(worktreeId: string, status: FixtureWorktreeStatus): void {
    const worktree = this.worktrees.find((w) => w.worktreeId === worktreeId)
    if (worktree) {
      worktree.status = status
      worktree.lastOutputAt = Date.now()
    }
  }

  dropConnection(): void {
    for (const socket of this.connections.keys()) {
      socket.close(1000, 'mock: dropConnection()')
    }
    this.connections.clear()
  }

  /** Arms the *next* e2ee_auth attempt (any connection) to fail with 'unauthorized'. */
  rejectAuth(): void {
    this.rejectNextAuth = true
  }

  /** Overrides `terminal.resolveActive`'s answer for `worktreeId` (`null` = ambiguous / no
   *  unique candidate — the ask/tail flows must fail closed rather than guess). */
  setActiveTerminal(worktreeId: string, terminalId: string | null): void {
    this.terminals.setActiveTerminal(worktreeId, terminalId)
  }

  /** Makes `terminal.send` to `terminalId` come back `accepted: false` (disconnected/read-only
   *  terminal) until re-enabled with `setTerminalWritable(id, true)`. */
  setTerminalWritable(terminalId: string, writable: boolean): void {
    this.terminals.setTerminalWritable(terminalId, writable)
  }

  /** Test-only: pushes host-originated output to every connection subscribed to `terminalId`,
   *  independent of terminal.send (which represents client-originated keystrokes). */
  pushTerminalOutputForTest(terminalId: string, text: string): void {
    this.terminals.appendOutput(terminalId, text)
    for (const [socket, state] of this.connections) {
      const subscription = state.terminalSubscriptions.get(terminalId)
      if (subscription) {
        publishTerminalOutput(this.terminalRpc, socket, state, subscription, text)
      }
    }
  }

  // ---- handshake --------------------------------------------------------------------------

  private handleMessage(socket: MemorySocketLike, data: string | ArrayBuffer): void {
    const state = this.connections.get(socket)
    if (!state) {
      this.handleHello(socket, data)
      return
    }
    if (typeof data !== 'string') {
      // Clients don't send binary frames in v1; ignore anything unexpected.
      return
    }
    if (!state.authenticated) {
      this.handleAuth(socket, state, data)
      return
    }
    this.handlePostAuthText(socket, state, data)
  }

  private handleHello(socket: MemorySocketLike, data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      socket.close(1002, 'expected e2ee_hello')
      return
    }
    let hello: { type?: string; publicKeyB64?: string }
    try {
      hello = JSON.parse(data)
    } catch {
      socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid JSON' }))
      socket.close()
      return
    }
    if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') {
      socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Expected e2ee_hello' }))
      socket.close()
      return
    }
    const clientPublicKey = base64ToBytes(hello.publicKeyB64)
    if (clientPublicKey.length !== 32) {
      socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid public key' }))
      socket.close()
      return
    }
    const sharedKey = nacl.box.before(clientPublicKey, this.keyPair.secretKey)
    this.connections.set(socket, {
      sharedKey,
      authenticated: false,
      notificationSubscriptionId: null,
      terminalSubscriptions: new Map()
    })
    socket.send(JSON.stringify({ type: 'e2ee_ready' }))
  }

  private handleAuth(socket: MemorySocketLike, state: ConnectionState, data: string): void {
    const plaintext = decryptText(data, state.sharedKey)
    if (plaintext === null) {
      return
    }
    let auth: { type?: string; deviceToken?: string }
    try {
      auth = JSON.parse(plaintext)
    } catch {
      return
    }
    const rejectThisAuth = this.rejectNextAuth
    this.rejectNextAuth = false
    if (rejectThisAuth || auth.type !== 'e2ee_auth' || auth.deviceToken !== this.deviceToken) {
      this.sendEncryptedText(socket, state, { type: 'e2ee_error', error: { code: 'unauthorized' } })
      socket.close()
      return
    }
    state.authenticated = true
    this.sendEncryptedText(socket, state, { type: 'e2ee_authenticated' })
  }

  // ---- RPC ----------------------------------------------------------------------------------

  private handlePostAuthText(socket: MemorySocketLike, state: ConnectionState, data: string): void {
    const plaintext = decryptText(data, state.sharedKey)
    if (plaintext === null) {
      return
    }
    let request: RpcRequestLike
    try {
      request = JSON.parse(plaintext)
    } catch {
      this.respond(socket, state, this.failure('unknown', 'bad_request', 'Invalid JSON'))
      return
    }
    this.handleRpc(socket, state, request)
  }

  private handleRpc(
    socket: MemorySocketLike,
    state: ConnectionState,
    request: RpcRequestLike
  ): void {
    this.onRequestForTest?.(request.method, request.params)
    switch (request.method) {
      case 'status.get':
        this.respond(
          socket,
          state,
          this.success(request.id, {
            protocolVersion: 3,
            minCompatibleMobileVersion: 2,
            appVersion: 'mock-1.0.0'
          })
        )
        return

      case 'worktree.ps':
        this.respond(
          socket,
          state,
          this.success(request.id, {
            worktrees: this.worktrees,
            totalCount: this.worktrees.length,
            truncated: false
          })
        )
        return

      case 'terminal.list':
        handleTerminalList(this.terminalRpc, socket, state, this.terminals, request)
        return

      case 'terminal.resolveActive':
        handleTerminalResolveActive(this.terminalRpc, socket, state, this.terminals, request)
        return

      case 'terminal.agentStatus':
        handleTerminalAgentStatus(this.terminalRpc, socket, state, this.terminals, request)
        return

      case 'terminal.send':
        handleTerminalSend(this.terminalRpc, socket, state, this.terminals, request)
        return

      case 'terminal.subscribe':
        handleTerminalSubscribe(this.terminalRpc, socket, state, this.terminals, request)
        return

      case 'terminal.unsubscribe':
        handleTerminalUnsubscribe(this.terminalRpc, socket, state, request)
        return

      case 'notifications.subscribe':
        state.notificationSubscriptionId = request.id
        this.respond(
          socket,
          state,
          this.success(request.id, { type: 'ready', subscriptionId: request.id }, true)
        )
        for (const event of createFixtureNotifications()) {
          this.pushNotification(event)
        }
        return

      case 'runtime.clientCapabilities.update':
        this.respond(socket, state, this.success(request.id, {}))
        return

      default:
        this.respond(
          socket,
          state,
          this.failure(request.id, 'method_not_found', `Unknown method: ${request.method}`)
        )
    }
  }

  private respond(socket: MemorySocketLike, state: ConnectionState, response: RpcResponse): void {
    const deliver = () => {
      if (socket.readyState === MEMORY_SOCKET_READY_STATE.OPEN) {
        this.sendEncryptedText(socket, state, response)
      }
    }
    if (this.delayMs > 0) {
      setTimeout(deliver, this.delayMs)
    } else {
      deliver()
    }
  }

  private success(id: string, result: unknown, streaming?: true): RpcSuccess {
    const response: RpcSuccess = { id, ok: true, result, _meta: { runtimeId: this.runtimeId } }
    if (streaming) {
      response.streaming = true
    }
    return response
  }

  private failure(id: string, code: string, message: string): RpcFailure {
    return { id, ok: false, error: { code, message }, _meta: { runtimeId: this.runtimeId } }
  }

  private sendEncryptedText(
    socket: MemorySocketLike,
    state: ConnectionState,
    message: unknown
  ): void {
    socket.send(encryptText(JSON.stringify(message), state.sharedKey))
  }
}
