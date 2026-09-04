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

These cover every canonical name another actor can act on — the socket endpoint above and the
`daemon-vN.pid` record — not just the socket path.

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
- **Do not add a sweeper over names that can be an actor's only copy.** Deciding whether someone
  else's leftover is safe to delete is the question this design retired; the last one produced
  five defects, including deleting a live listener's only pathname. Every actor removes its own
  scratch name on each non-crash path. This still bans a sweeper over the bind name and over
  `.swap-`/`.hold-` claims, which briefly hold the only copy of a live daemon's endpoint, token,
  or PID record. See the one documented exception below before adding another.
- **Scratch namespaces must stay out of released builds' patterns.** Shipped versions sweep
  `^\.b[0-9a-f]{10}$` on age alone with no liveness check, which is why the bind name is `.p`.
  Deleting our sweeper does not un-ship theirs.
- **Never remove the endpoint on shutdown.** A departing daemon leaves a dead entry; the next
  publisher replaces it in one rename.

**Residual risk.** The final probe and the `rename` are two syscalls, and POSIX has no
rename-if-target-is-inode-X. The harm is separately unreachable: a daemon never creates a session
on an endpoint it no longer holds (`daemon-server.ts`), and it drains rather than serving on.

## The One Namespace We Do Sweep: Publish Scratch

`reapOrphanedDaemonPidPublishClaims` (`daemon-pid-publish-claim-reap.ts`) deletes
`daemon-vN.pid.publish-<pid>-<uuid>` names it did not create, at the launch funnel
(`DaemonSpawner.ensureRunning`). That is a deliberate exception to the rule above, not an
oversight, and it holds only because both premises behind the ban fail here:

- **It is never anyone's only copy.** Before `linkSync` the claim is unpublished bytes no reader
  looks for; after it, the canonical name holds the same inode. Losing one costs at most the
  atomic path for that publish, which then degrades to the exclusive direct write. A bind name or
  a `.swap-`/`.hold-` claim, by contrast, can be the only name a live daemon's endpoint or record
  has — which is why sweeping those stays banned.
- **It deletes only on proven death, never on age.** The owner pid is read out of the name and
  must return `ESRCH`. A live pid, this process, `EPERM`, and any other errno all preserve the
  claim, so pid recycling only keeps junk around longer — the safe direction. This is the fence
  the exception rests on: weaken it and the exception is gone with it.

**Why not just let them leak:** a publisher killed between the write and the `finally` never runs
its own cleanup, and nothing else ever would. The reaper matches retired protocol versions on
purpose, because a `daemon-vN.pid` for a version no longer current is exactly what nothing heals.

**Still in force here:** the name stays outside released builds' sweep patterns (pinned in
`daemon-spawner.test.ts`, "keeps every scratch namespace outside the released sweeper pattern"),
and the reaper must keep ignoring `.swap-`/`.hold-` (pinned in
`daemon-pid-publish-claim-reap.test.ts`, "touches nothing but publish scratch").
