// Why: the runtime client used to live here as a single file. It was split
// into ./runtime/{types,metadata,transport,status,launch,client}.ts so each
// concern can be tested in isolation. This barrel preserves the original
// import surface so call sites (src/cli/index.ts, tests) remain unchanged.
export {
  RuntimeClient,
  RuntimeClientError,
  RuntimeRpcFailureError,
  getDefaultUserDataPath,
  type RuntimeRpcFailure,
  type RuntimeRpcResponse,
  type RuntimeRpcSuccess
} from './runtime/index'
