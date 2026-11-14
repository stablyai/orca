import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

// Why: the routing table is the one list of phone methods, so allowlisting a method means routing it.
export const MOBILE_RPC_METHOD_ALLOWLIST = new Set(MOBILE_RPC_METHOD_ROUTES.keys())
