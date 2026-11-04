// Keep mock registration ahead of bindings used only by terminal RPC scenarios.
import './setup.spec'

export { RpcDispatcher } from '../rpc/dispatcher'
export { TERMINAL_METHODS } from '../rpc/methods/terminal'
