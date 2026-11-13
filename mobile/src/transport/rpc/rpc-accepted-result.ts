// Keep verdict-only imports outside the operation cast fence; raw-envelope consumers still need their existing assertions.

/** A skip-policy verdict: refusal is distinct from an accepted null/undefined payload. */
export type RpcAcceptedResult<Value> =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly value: Value }
