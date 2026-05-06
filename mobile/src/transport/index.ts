export { connect, type RpcClient } from './rpc-client'
export {
  loadHosts,
  saveHost,
  removeHost,
  renameHost,
  getNextHostName,
  updateLastConnected
} from './host-store'
export type {
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  RpcFailure,
  ConnectionState,
  HostProfile,
  PairingOffer
} from './types'
export { PairingOfferSchema, PAIRING_OFFER_VERSION } from './types'
