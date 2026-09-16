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
 * reader can tell an import from a regression. #20954 brought three
 * (`notification-stream-closed`, `native-chat-session-page`, `terminal-buffer-cleared`) and step 6's
 * second migration brought two (`created-terminal-tab`, `terminal-display-mode-set`).
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
  // browser
  { file: 'src/browser/mobile-browser-command-operations.ts', readers: 1 },
  // components
  { file: 'src/components/codex-reset-credit-capability-operations.ts', readers: 1 },
  { file: 'src/components/codex-reset-credit-consume-operations.ts', readers: 1 },
  { file: 'src/components/new-workspace-operations.ts', readers: 2 },
  // dictation
  { file: 'src/dictation/mobile-dictation-operations.ts', readers: 8 },
  // files
  { file: 'src/files/mobile-file-explorer-operations.ts', readers: 2 },
  { file: 'src/files/mobile-file-ownership-operations.ts', readers: 2 },
  { file: 'src/files/mobile-file-preview-operations.ts', readers: 6 },
  { file: 'src/files/mobile-file-tab-doc-operations.ts', readers: 3 },
  // home
  { file: 'src/home/mobile-home-host-operations.ts', readers: 2 },
  // host-screen
  { file: 'src/host-screen/host-screen-operations.ts', readers: 8 },
  // notifications
  { file: 'src/notifications/desktop-notification-stream-operations.ts', readers: 1 },
  { file: 'src/notifications/mobile-push-delivery-test-operations.ts', readers: 1 },
  { file: 'src/notifications/mobile-push-registration-operations.ts', readers: 2 },
  { file: 'src/notifications/push-dismissal-operations.ts', readers: 1 },
  // session
  { file: 'src/session/github-pr-mutation-operations.ts', readers: 4 },
  { file: 'src/session/github-pr-read-operations.ts', readers: 8 },
  { file: 'src/session/mobile-clipboard-image-operations.ts', readers: 5 },
  { file: 'src/session/mobile-diff-review-git-operations.ts', readers: 2 },
  { file: 'src/session/mobile-diff-review-operations.ts', readers: 3 },
  { file: 'src/session/mobile-review-terminal-operations.ts', readers: 3 },
  { file: 'src/session/mobile-session-launch-operations.ts', readers: 7 },
  { file: 'src/session/mobile-session-read-operations.ts', readers: 11 },
  { file: 'src/session/mobile-session-write-operations.ts', readers: 10 },
  // tasks
  { file: 'src/tasks/mobile-task-item-comment-operations.ts', readers: 7 },
  { file: 'src/tasks/mobile-task-item-detail-operations.ts', readers: 8 },
  { file: 'src/tasks/mobile-task-item-state-operations.ts', readers: 17 },
  { file: 'src/tasks/mobile-task-list-operations.ts', readers: 6 },
  { file: 'src/tasks/mobile-task-project-board-operations.ts', readers: 17 },
  { file: 'src/tasks/mobile-task-runtime-operations.ts', readers: 7 },
  { file: 'src/tasks/mobile-task-source-search-operations.ts', readers: 7 },
  // #19850 brought the fifth (`agent-launch-receipt`): mobile's create routes through agent.launch
  // when the host advertises it, and that reply is re-typed exactly as the four beside it are.
  { file: 'src/tasks/mobile-workspace-create-operations.ts', readers: 5 },
  { file: 'src/tasks/mobile-workspace-source-operations.ts', readers: 7 },
  // terminal
  { file: 'src/terminal/mobile-terminal-operations.ts', readers: 4 },
  // transport
  { file: 'src/transport/host-status-probe-operations.ts', readers: 1 },
  { file: 'src/transport/mobile-relay-pairing-operations.ts', readers: 2 },
  // worktree
  { file: 'src/worktree/worktree-catalog-operations.ts', readers: 2 }
]
