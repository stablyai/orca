import 'zod'
import '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import '../connection/mobile-runtime-host-platform'
import '../../../../src/shared/validation/zod-salvage'
import '../hosts/host-status-reply-schema'

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type {
  RpcFailure,
  RpcResponse,
  RpcSuccess
} from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
