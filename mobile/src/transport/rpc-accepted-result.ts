// Its own module because a consumer that only names this verdict is not an operation
// implementation: importing rpc-operation-contract would pull it into the cast fence's region
// and ban the assertions it legitimately still makes on the raw envelope.

/** A skip-policy verdict: refusal is distinct from an accepted null/undefined payload. */
export type RpcAcceptedResult<Value> =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly value: Value }
