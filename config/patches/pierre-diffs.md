# Pierre 1.4.1 edit highlighting

Orca primes syntax highlighting in workers before mounting a diff. Pierre's edit
session normally ignores that cache and synchronously highlights the complete
file again. A 60,000-line TypeScript fixture blocked the renderer for over two
seconds, despite row virtualization.

The patch lets a newly created edit session adopt a compatible worker result,
copying its mutable additions array as Pierre already does for a rendered
external result. Loading the editor's local grammar then leaves that result
intact. Existing active sessions keep their edited cache.

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
