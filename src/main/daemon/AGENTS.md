# AGENTS.md — Terminal Daemon

## Endpoint Ownership: Who May Touch the Socket Path

Two invariants govern the daemon's canonical socket path. Read this before changing anything that
links, renames, unlinks or stats it — or that treats its existence as evidence a daemon is running.

> **Only a daemon publishing itself onto the canonical endpoint may mutate that directory entry,
> and only by replacing an entry it has itself just proven dead.**
>
> **No actor removes a name it did not create.**

**Why it exists.** `net.Server.close()` unlinks the pathname it bound with no ownership check, so a
departing daemon deleted whichever socket then sat at the canonical path — including a live
replacement's. The replacement stayed alive hosting PTYs no client could reach, which reads to the
user as terminals that accept keystrokes and never run them. Seven review rounds against the older
"launcher reclaims a dead process's name" shape produced twenty-three defects, all the same
interleaving: a third party observing liveness at T and acting on the directory entry at T+1.

**The protocol** (`daemon-endpoint-ownership.ts`): bind a private `.p<hex>` name → try an exclusive
`link` → on `EEXIST` prove the incumbent dead by connecting → re-check the entry hasn't changed
hands → probe once more → `rename` in one syscall → verify we kept it.

## Traps That Already Cost Us

- **Never collapse "can't tell" into "dead."** Only `connected` means occupied; only
  `refused`/`missing` prove death. A timeout or `EPERM` proves nothing and must decline — treating
  it as death deletes an endpoint still serving every terminal on the host.
- **`link` first, never an unconditional `rename`.** `rename` replaces whatever it finds, so it
  would let a starting daemon destroy a healthy one. `link` fails loudly and forces the liveness
  question.
- **`rename`, never `unlink`-then-`link`.** The latter leaves the name absent between two calls;
  measured across a live handover it gapped on essentially every observation, where `rename` gapped
  on none in ~14,500 probes.
- **Do not identify an entry by `birthtimeMs`.** Node documents it as sometimes holding the ctime,
  filesystems without a birth time report the epoch, and its granularity is often coarser than the
  events it must separate. Three attempts to patch around this produced three more defects; inode
  recycling is now settled by asking whether anything is _serving_.
- **Do not add a sweeper.** Deciding whether someone else's leftover is safe to delete is the
  question this design retired; the last one produced five defects, including deleting a live
  listener's only pathname. Every actor removes its own scratch name on each non-crash path.
- **Scratch namespaces must stay out of released builds' patterns.** Shipped versions sweep
  `^\.b[0-9a-f]{10}$` on age alone with no liveness check, which is why the bind name is `.p`.
  Deleting our sweeper does not un-ship theirs.
- **Never remove the endpoint on shutdown.** A departing daemon leaves a dead entry; the next
  publisher replaces it in one rename.

**Residual risk.** The final probe and the `rename` are two syscalls, and POSIX has no
rename-if-target-is-inode-X. The harm is separately unreachable: a daemon never creates a session
on an endpoint it no longer holds (`daemon-server.ts`), and it drains rather than serving on.
