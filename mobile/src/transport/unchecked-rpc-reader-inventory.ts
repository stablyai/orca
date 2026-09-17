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
 * The count is per file and is a ceiling, not a target: unchecked-rpc-reader-boundary.test.ts fails
 * on a file that is not listed, on a listed file that no longer has one, and on a listed file whose
 * count went up. Replacing a reader with `rpcResultVariant(variant, schema)` lowers its line; the
 * list only shrinks.
 *
 * A merge is the one case where a line goes up without a migration undoing itself: main can land an
 * operation the branch never saw. Raise the line then, and name the PR that brought it, so the next
 * reader can tell an import from a regression. Of the three #20954 brought,
 * `native-chat-session-page` is still here; `notification-stream-closed` and
 * `terminal-buffer-cleared` were converted by the notifications/terminal batch.
 *
 * A file leaves the list by deletion, not by reaching zero: an entry asserts the file still holds
 * at least one unchecked reader, so a `readers: 0` line is itself a failure. Migrating a domain
 * therefore removes its files outright.
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
 * The reason is shared by every line and is stated once here instead of 37 times: the reply has no
 * schema, so the operation declares what the payload is by assertion. Writing one schema per
 * consumed member — required exactly where the consumer reads it unguarded, optional everywhere
 * else, never `.strict()` — turns the assertion into a check and deletes the line.
 */
export const UNCHECKED_RPC_READERS: readonly UncheckedRpcReaderEntry[] = [
  // agent-history
  { file: 'src/agent-history/mobile-agent-history-operations.ts', readers: 6 },
  // dictation
  { file: 'src/dictation/mobile-dictation-operations.ts', readers: 8 },
  // files
  { file: 'src/files/mobile-file-explorer-operations.ts', readers: 2 },
  { file: 'src/files/mobile-file-ownership-operations.ts', readers: 2 },
  { file: 'src/files/mobile-file-preview-operations.ts', readers: 6 },
  { file: 'src/files/mobile-file-tab-doc-operations.ts', readers: 3 },
  // host-screen
  { file: 'src/host-screen/host-screen-operations.ts', readers: 8 }
]
