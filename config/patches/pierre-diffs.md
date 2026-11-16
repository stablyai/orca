# Pierre 1.6.2 integration patch

Orca primes syntax highlighting in workers before mounting a diff. Pierre's edit
session normally ignores that cache and synchronously highlights the complete
file again. A 60,000-line TypeScript fixture blocked the renderer for over two
seconds, despite row virtualization.

The patch lets a newly created edit session adopt a compatible worker result,
giving its additions array independent setters while retaining lazy worker rows.
Mounting or realigning an edit session therefore does not decode every row.
Loading the editor's local grammar leaves the adopted result intact. Existing
active sessions keep their edited cache.

Orca also opts out of synchronous hunk recomputation when discarding a mounted
instance. Draft text is already owned by Orca, and the next mount computes hunks
in a worker. The opt-out preserves completion notifications, live document text,
and edit history; their hunk metadata retains its edit-session shape. Upstream's
default cleanup behavior remains unchanged.

The gutter utility also accepts an optional range predicate and accessible label.
Orca uses these to hide note controls on original or ineligible review lines,
reject ranges crossing an ineligible line, and retain each surface's note label.
Drag completion rechecks the predicate. Other consumers retain the upstream defaults.

Keep `useTokenTransformer: true` on the pool. Coverage lives in
`pierre-diff-worker-edit-cache.test.ts` and the large-diff Electron specs. Remove
the patch when an upstream release provides the same behavior.

The package entrypoint also exposes its existing `iterateOverDiff` iterator.
Search uses it to map original/context line numbers onto virtualized split and
unified rows, reusing Pierre's hunk logic without copying its implementation.

`Editor.setDeletedTextSelectionActive` exposes the existing original-side selection
mode. Native selection restoration and search closing use it to clear modified-side
carets and keep the original selection visible without simulating pointer input.

The migration now uses upstream 1.6.2. Upstream source for this refresh is `pierrecomputer/pierre`, revision `70d1e34`. Its compact worker
transport and lazy line ASTs replace the old whole-AST structured clone. The
remaining patch covers editor-cache adoption, cleanup, gutter eligibility, the
existing diff iterator export, and original-side selection control. It also
retires a worker when its last consumer cancels, replaces crashed workers, and
bounds replacement initialization and render execution. Shared tasks keep running
for surviving consumers until completion or the execution deadline. If no worker
survives a failed replacement, queued consumers receive an error so Retry can
start fresh work.

Same-line-count edits also retain replacement hunks when whitespace is ignored.
The cached original-line set uses the same trimmed comparison as jsdiff; an edit
that matches an original line still rebuilds the hunks. This avoids a full-file
diff on each keystroke in large replacements without hiding reverted changes.

The editor also accepts an optional `createTokenizer` factory. Orca supplies an
async adapter for plugin languages, using the existing terminable plugin grammar
worker and its progress/document deadlines. A failed initial plugin highlight
falls back to plain text so edit mode can still attach. Worker-only grammars
register empty patterns with the renderer's Shiki backend; full patterns are
attached only inside highlight workers. The existing 30-second render execution
deadline retires and replaces a stalled read-only highlight worker.

`VirtualizedFileDiff.layoutVersion` exposes the existing layout invalidation
counter. The overview ruler reads this counter in post-render callbacks and uses
`getLinePosition` only after diff/layout changes, including context expansion;
scroll-only renders do not recompute marker geometry.

All file-content parses share a 50 ms / 2,048-edit line-diff budget, including
worker parses and synchronous edit-session recomputes. On exhaustion, the existing
patch processor receives one replacement hunk after exact common leading and
trailing lines are trimmed. Both file bodies and missing-final-newline markers
remain intact. This follows the existing bounded-diff/replacement pattern.
Edit-session hunk rebuilding parses only the divergence region with four lines
of boundary context, then restores absolute coordinates before existing blank-line
alignment and expansion remapping. No editor or selection behavior is replaced.
