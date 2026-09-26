# Terminal artifact grant integrity

Clicking a path in terminal output mints a short-lived grant over one file in a
world-writable temp directory. Between minting the grant and using it, anything on the
host can replace that file. This page is the contract for the checks that catch such a
replacement — and, more importantly, for the windows they do **not** close.

Read this before weakening a check in
`src/main/runtime/runtime-file-commands-terminal-artifact-access.ts`, before assuming
the sequence is atomic, or before extending the guarantee to remote hosts.

## The stat identity is weaker than it looks

A grant pins the file as `dev:ino:nlink:size:mtimeMs`. Four of those five fields
survive an unlink-and-recreate at the same path, measured on Linux (Node 24) by
replaying that exact sequence:

| Field     | After `rm` + recreate in the same directory                              |
| --------- | ------------------------------------------------------------------------ |
| `dev`     | unchanged — same filesystem                                              |
| `ino`     | **reused 100% of the time** (3000/3000); ext4 hands back the freed inode |
| `nlink`   | `1` before and after                                                     |
| `size`    | unchanged whenever the replacement is the same length                    |
| `mtimeMs` | **quantised to 1 ms** — the kernel's coarse clock advances once a tick   |

So for a same-length replacement the whole identity string collapses to a 1 ms
timestamp race. The full string collided in 63.7% of back-to-back iterations, 19.8%
with a 0.5 ms gap, and 0% at ≥1 ms. The same probe on macOS collided 0 times in 2000 —
no inode reuse, nanosecond mtimes — which is why this only ever showed up on Linux CI.

`ino` contributes no discriminating power against the exact case it is there to catch.
Do not add `ctimeMs` or `birthtimeMs` hoping to fix this: they come from the same
coarse clock and collide in the same window. `bigint: true` stats do not help either —
the precision loss is in the stored kernel timestamp, not in Node's `Number`.

## The content digest sits alongside the identity, and cannot replace it

Local grants also pin a sha256 of the artifact's bytes, read from the **same open
handle** as the stat so the two describe one inode with no gap between them.

The identity string stays exactly as it is because it is a wire contract, not a
host-local detail: `src/relay/fs-handler-terminal-artifact.ts` recomputes that same
`dev:ino:nlink:size:mtimeMs` format field-for-field from its own stat and compares it
against the `expectedStatIdentity` the host sends. Changing the format would have a new
host publishing a string an older relay can never reproduce, failing every remote
artifact read as `terminal_file_grant_stale` — a break that reaches old peers with no
wire-schema change at all. See [remote wire compatibility](./remote-wire-compatibility.md).

## What is still open

The digest narrows these checks. It does not make any of them atomic.

- **Read and preview — closed.** The bytes returned to the caller are the same
  in-memory buffer that was digested, with no re-read in between, and the handle pins
  the inode for the whole operation. A swap landing after the `open` leaves the handle
  on the granted inode, so the granted content is what is served; a swap landing before
  it fails the digest.
- **Write — a window survives.** Between the final pre-rename verification and the
  `rename()` itself, the target path can still be swapped, and the rename clobbers
  whatever is there. POSIX `rename()` has no "only if the target is still inode X"
  form; Linux's `renameat2(RENAME_EXCHANGE)` would close it but is not portable and is
  not exposed by Node. Narrowing this further means changing the commit strategy, not
  adding another check before it.
- **Artifacts over 10 MB fall back to stat-only.** They digest to `null`, so only the
  identity guards them. Nothing leaks: every read, preview, and write path rejects on
  size before reading. The weakness is unreachable, not fixed — a later cap change
  could expose it.
- **Remote and SSH grants are untouched.** They keep the stat-only check, with the full
  1 ms weakness on whatever filesystem the relay runs. Closing it needs a negotiated
  capability so an older relay is never sent a digest it cannot verify.

## What is proven, and what is inferred

The filesystem numbers above are direct measurements. That identical stats plus changed
content previously returned the swapped bytes, and now do not, is pinned by
`orca-runtime-files-terminal-artifact-swap-detection.test.ts`, which replays the first
stat seen for a path so the collision is deterministic rather than a 1 ms coin flip.

The join between the two is a chain, not a single observation. This defect surfaced as
an intermittent failure of `orca-runtime-files-terminal-artifact-io.test.ts` on
`rejects stale absolute terminal artifact previews before returning changed content`,
which swaps an 8-byte artifact for 8 different bytes. No one has instrumented a Linux
runner to prove that a specific CI failure was a same-tick mtime collision; the
conclusion rests on every ingredient being measured separately. Treat it accordingly if
a future failure does not fit.
