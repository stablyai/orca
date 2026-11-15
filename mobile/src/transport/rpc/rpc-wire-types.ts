import 'zod'
import '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import '../connection/mobile-runtime-host-platform'
import '../../../../src/shared/zod-salvage'
import '../hosts/host-status-reply-schema'

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

// Wire validation does not require _meta, and shell-produced native replies have no runtime to name.
export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta?: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta?: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure
