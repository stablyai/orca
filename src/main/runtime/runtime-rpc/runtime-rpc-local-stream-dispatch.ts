import { randomBytes } from 'node:crypto'
import {
  RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES,
  RUNTIME_LOCAL_STREAM_PROTOCOL,
  RUNTIME_LOCAL_STREAM_UNSUPPORTED_CODE,
  RUNTIME_LOCAL_STREAM_VERSION,
  RuntimeLocalStreamUpgradeParams,
  type RuntimeLocalStreamUpgradeResult
} from '../../../shared/runtime-local-stream-protocol'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { errorMessage } from '../../../shared/error-message'
import type { RpcRequest } from '../rpc/core'
import { errorResponse, successResponse } from '../rpc/errors'
import { LOCAL_CLI_RPC_CALLER } from '../rpc/rpc-caller-identity'
import { OWNER_RPC_CALLER_SCOPE } from '../rpc/rpc-caller-scope'
import { parseRuntimeClientCapabilities } from '../rpc/runtime-client-capabilities'
import type { UnixSocketStreamConnection } from '../rpc/unix-socket-stream-connection'
import type { UnixSocketStreamUpgrade } from '../rpc/unix-socket-stream-upgrade'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'
import { RUNTIME_RPC_REPLY_TOO_LARGE_CODE } from './runtime-rpc-reply-size-limit'
import { RuntimeRpcWebSocketDispatch } from './runtime-rpc-websocket-dispatch'

type LocalStreamSession = {
  connection: UnixSocketStreamConnection
  connectionId: string
  clientCapabilities: readonly RuntimeCapability[]
  dispatches: Set<AbortController>
}

export class RuntimeRpcLocalStreamDispatch extends RuntimeRpcWebSocketDispatch {
  protected readonly localStreamConnections = new Set<UnixSocketStreamConnection>()

  // Why: owner-only — the token proves the caller can read the 0o600 metadata file, which is the same
  // boundary the unary socket trusts; bridged SSH credentials stay on unary calls.
  protected handleLocalStreamUpgrade(rawMessage: string, upgrade: UnixSocketStreamUpgrade): void {
    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      upgrade.reject(JSON.stringify(parsed.error))
      return
    }
    const { request, callerScope } = parsed
    if (callerScope.kind !== 'owner') {
      upgrade.reject(
        JSON.stringify(
          this.buildError(request.id, 'forbidden', 'Streaming requires the owner token')
        )
      )
      return
    }
    const params = RuntimeLocalStreamUpgradeParams.safeParse(request.params)
    if (
      !params.success ||
      params.data.protocol !== RUNTIME_LOCAL_STREAM_PROTOCOL ||
      !params.data.versions.includes(RUNTIME_LOCAL_STREAM_VERSION)
    ) {
      upgrade.reject(
        JSON.stringify(
          errorResponse(
            request.id,
            { runtimeId: this.runtime.getRuntimeId() },
            RUNTIME_LOCAL_STREAM_UNSUPPORTED_CODE,
            `This runtime streams ${RUNTIME_LOCAL_STREAM_PROTOCOL} version ${RUNTIME_LOCAL_STREAM_VERSION} only`,
            { protocol: RUNTIME_LOCAL_STREAM_PROTOCOL, versions: [RUNTIME_LOCAL_STREAM_VERSION] }
          )
        )
      )
      return
    }
    const connectionId = `local-stream-${randomBytes(8).toString('hex')}`
    const result: RuntimeLocalStreamUpgradeResult = {
      protocol: RUNTIME_LOCAL_STREAM_PROTOCOL,
      version: RUNTIME_LOCAL_STREAM_VERSION,
      connectionId
    }
    const connection = upgrade.accept(
      JSON.stringify(
        successResponse(request.id, { runtimeId: this.runtime.getRuntimeId() }, result)
      )
    )
    if (!connection) {
      return
    }
    const session: LocalStreamSession = {
      connection,
      connectionId,
      clientCapabilities: parseRuntimeClientCapabilities(params.data.clientCapabilities),
      dispatches: new Set()
    }
    this.localStreamConnections.add(connection)
    connection.bind({
      onText: (text) => {
        void this.trackClientRequest(() => this.handleLocalStreamText(session, text))
      },
      onBinary: (bytes) => {
        this.lastClientRequestAt = Date.now()
        this.binaryMessageRouter.dispatch(connectionId, bytes)
      },
      onClose: () => this.closeLocalStreamSession(session)
    })
  }

  private closeLocalStreamSession(session: LocalStreamSession): void {
    if (!this.localStreamConnections.delete(session.connection)) {
      return
    }
    for (const controller of session.dispatches) {
      controller.abort()
    }
    session.dispatches.clear()
    this.runtime.cleanupSubscriptionsForConnection(session.connectionId)
    this.binaryMessageRouter.deleteConnection(session.connectionId)
    this.runtime.onClientDisconnected(session.connectionId)
  }

  private async handleLocalStreamText(session: LocalStreamSession, text: string): Promise<void> {
    const { connection, connectionId } = session
    let request: RpcRequest
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: id, method and authToken are checked below; the dispatcher's admission validates the rest of the envelope, as on the WebSocket path.
      request = JSON.parse(text) as RpcRequest
    } catch {
      connection.sendText(
        JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request'))
      )
      return
    }
    if (typeof request !== 'object' || request === null) {
      connection.sendText(
        JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request'))
      )
      return
    }
    if (typeof request.id !== 'string' || request.id.length === 0) {
      connection.sendText(
        JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id'))
      )
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      connection.sendText(
        JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method'))
      )
      return
    }
    // Why: the upgrade already authenticated the connection; a repeated token may only restate it.
    if (request.authToken !== undefined && request.authToken !== this.authToken) {
      connection.sendText(
        JSON.stringify(this.buildError(request.id, 'unauthorized', 'Auth token mismatch'))
      )
      return
    }

    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      connection.sendText(JSON.stringify(this.buildError(request.id, 'runtime_busy', rejection)))
      return
    }
    const controller = new AbortController()
    session.dispatches.add(controller)
    const reply = (response: string): void => {
      if (Buffer.byteLength(response, 'utf8') <= RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES) {
        connection.sendText(response)
        return
      }
      connection.sendText(
        JSON.stringify(
          this.buildError(
            request.id,
            RUNTIME_RPC_REPLY_TOO_LARGE_CODE,
            'The result is larger than one local stream frame can carry.'
          )
        )
      )
    }
    try {
      await this.dispatcher.dispatchStreaming(request, reply, {
        connectionId,
        clientId: connectionId,
        clientKind: 'runtime',
        // Why: the upgrade proved the same owner token a unary call does, so it is the same caller.
        caller: LOCAL_CLI_RPC_CALLER,
        callerScope: OWNER_RPC_CALLER_SCOPE,
        clientCapabilities: session.clientCapabilities,
        signal: controller.signal,
        sendBinary: (bytes) => connection.sendBinary(bytes),
        registerBinaryStreamHandler: (streamId, handler) =>
          this.registerBinaryStreamHandler(connectionId, streamId, handler),
        registerBinaryMessageHandler: (handler) =>
          this.registerBinaryMessageHandler(connectionId, handler)
      })
    } catch (error) {
      // Why: a throw past the dispatcher must still settle this id; the stream stays usable for others.
      reply(JSON.stringify(this.buildError(request.id, 'internal_error', errorMessage(error))))
    } finally {
      session.dispatches.delete(controller)
      this.releaseLongPoll(longPoll)
    }
  }
}
