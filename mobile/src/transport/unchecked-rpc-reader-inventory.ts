/**
 * Every RpcOperation reader that re-types its reply instead of validating it, held as data.
 *
 * A reader is unchecked when it answers `compatible: true` for every payload a byte can carry:
 * a call to `rpcUncheckedPayloadReader`, `rpcUncheckedMemberReader` or `rpcReadUnchecked` in
 * rpc-reader-payload.ts. Step 4 moved the call-site cast into the operation's `read`; it did not
 * make the cast true. A malformed reply still reaches the consumer as the declared type and fails
 * somewhere downstream — a property read on null, a `.map` on a string, a rendered `undefined` —
 * with nothing naming the reply as the cause.
 *
 * The list is empty. Step 7 converted the last domains it named, so the countdown is over and the
 * ratchet has flipped direction: unchecked-rpc-reader-boundary.test.ts now fails on the first
 * unchecked reader anywhere under `app/` or `src/`, and nothing may be added back. That includes a
 * merge bringing an operation this branch never saw — convert it with
 * `rpcResultVariant(variant, schema)` in the merge rather than reopening a line here.
 *
 * Two holes this list does not close, both deliberate:
 *   - A hand-written reader that returns `{ compatible: true, ... }` without going through those
 *     three helpers is not counted. It is the same hole with different bytes; the AST cannot tell
 *     a projecting reader that validated its input from one that did not.
 *   - `rpcPayloadMember` at a call site outside a reader. That is an unchecked member read, not a
 *     reader, and it is fenced by the raw-port inventory instead.
 */
export type UncheckedRpcReaderEntry = {
  readonly file: string
  readonly readers: number
}

/**
 * Files holding at least one unchecked reader, grouped by the feature area that owns them.
 *
 * Empty, and the entry shape outlives it: the boundary test measures the scan against this list, so
 * an empty list is what makes "no unchecked reader ships" an assertion rather than a claim.
 */
export const UNCHECKED_RPC_READERS: readonly UncheckedRpcReaderEntry[] = []
