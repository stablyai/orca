# macOS daemon TCC attribution

Why an Orca terminal on macOS can suddenly start getting `EPERM: operation not permitted` on
everything under `~/Documents`, `~/Desktop`, or `~/Downloads` while Full Disk Access is granted
and the same folder reads fine from a fresh terminal, what Orca does about it today, and what
the structural fix is (#17696, STA-3491).

Read this before changing `src/main/daemon/daemon-tcc-attribution.ts`, the severed branches in
`daemon-replacement-preflight.ts` and `daemon-pty-daemon-recovery.ts`, or how the daemon is
launched.

## The mechanism, as measured

Everything below was established with a harness that launches a stand-in app under launchd (so
it is its own TCC responsible process, like the real app), has it fork a detached daemon the
way `launchDaemonChild` does, and reads `~/Documents` from the daemon's grandchildren while
mutating the bundles underneath. The harness reproduced the production denial exactly.

1. **Attribution rides on the app that forked the daemon.** Every access from a daemon-hosted
   terminal is attributed to that app: by pid while it lives, and afterwards by its recorded
   executable path. `login(1)` in the chain changes nothing. The daemon's own image is not what
   is checked: a daemon whose image was deleted kept full access as long as the forker's path
   resolved, even with a different signed build sitting at that path.
2. **One failed resolution poisons the lineage for the daemon's lifetime.** If an evaluation
   happens while the forker's path cannot be resolved, the denial is cached below `tccd` (it
   logs nothing) against the daemon's lineage. Every later process under that daemon is denied,
   and restoring the path does not clear it. Only the daemon process dying clears it.
3. **The updater creates that window on every update.** Squirrel installs by moving the running
   bundle out of `/Applications/Orca.app` and moving the new one in; the path is absent for a
   moment between the two. A daemon that outlives enough updates, with hundreds of terminals
   doing I/O, eventually has an evaluation land in that window. Squirrel also empties the parked
   copy on the update after, so such a daemon is also running from an unlinked image.

Consequences worth stating plainly: version skew, PPID 1, a deleted spawner binary, and an
in-place bundle replacement are all fine on their own. Quitting and relaunching Orca reuses
the poisoned daemon. `codesign --verify +<pid>` failing with "host has no guest" does not
prove a denial; it is only a warning sign of an older running image.

## What Orca does today

`getMacDaemonTccAttributionHealth` reports `severed` only for a measured folder-access
divergence associated with the authenticated daemon incarnation. A missing spawner binary or
unresolvable running image is `at-risk`, not proof of denial. An inconclusive probe is
`unknown`; both states fail open for normal admission. `intact` means the diagnostic code
identity is valid, not that every protected path has been tested.

Denial evidence is persisted beside the PID record and matched by PID, start time, and launch
nonce, so app relaunch does not forget it and a replacement daemon starts clean. Fresh-spawn
admission reads evidence only: it never waits for `ps` or `codesign`. Diagnostic probes remain
on startup/settings/recovery paths, and cannot overwrite a newer denial with `intact`.

A `severed` verdict keeps live sessions alive in every path: with zero live sessions the
daemon is replaced at launch; with live sessions it is adopted in `degraded-new-pty-fallback`
mode so fresh terminals run in-process with the app's own attribution; and when the verdict
flips mid-session the adapter asks the provider owner to swap to degraded routing without a
restart. Degraded routing recovers on macOS only when the daemon is healthy and attribution
diagnostics are `intact`; unknown is insufficient to reverse an existing degraded decision. The
Manage Sessions restart remains the full remedy.

## The structural fix

Make the daemon its own responsible process, launched by launchd from an Orca-owned clone of
the app bundle. Its responsible path is then one the updater never touches, so no evaluation
can ever fail to resolve it, and nothing can be poisoned. Validated in the same harness: a
launchd-spawned daemon from an owned clone kept access through an in-place replacement of the
installed bundle by a different build and through outright deletion of it, with and without
`login(1)`. This is the macOS analog of the Windows daemon-host relocation; on APFS the clone is
a `clonefile` copy, so it costs almost nothing, and it is pruned once no daemon runs from it.
The identity of the clone is the same signed `com.stablyai.orca`, so existing grants apply.

Not a fix: disclaiming responsibility at the shell, which hands Orca's grants to arbitrary
shell processes.

## Rules

- Never infer attribution from `appVersion` skew or from PPID. Both are false positives that
  would kill live sessions after every update.
- Treat `unknown` as "do nothing". Only `severed` may change routing, and only `severed` with
  zero live sessions may replace a daemon automatically.
- `updater-cache` in `classifyDaemonSpawnerPath` must match the `$TMPDIR/*.ShipIt.*` parking
  directory, not only `~/Library/Caches/*ShipIt/`.
- Keep all three folder usage strings in `extendInfo` (Documents, Desktop, Downloads). Without a
  string macOS cannot prompt for that folder and denies silently.
- The fallback for degraded routing is `getInProcessPtyProvider()`, never `getLocalPtyProvider()`.
  After daemon install the latter returns the daemon topology itself, so a degraded provider
  built from it routes fresh terminals straight back onto the severed daemon. The daemon lands
  before PTY handlers register, so `configureLocalPtyProvider` must configure the in-process
  instance regardless of what is installed, or fallback terminals spawn without hook env or
  runtime callbacks.
- Check provider identity and `isDaemonRestartInFlight()` again after asynchronous discovery;
  dispose only candidate subscriptions if restart, disconnect, or another swap won the race.
- In-process runtime event delivery and quit/reload cleanup remain owned by the in-process
  provider even when it is wrapped. Daemon terminals retain daemon persistence semantics.

## Diagnosing a report

```
ps -axo pid,ppid,lstart,command | grep "Orca Helper"     # the daemon; PPID 1 is normal
codesign --verify +<daemon pid>                          # "host has no guest" => outlived two updates
ls -d $TMPDIR/com.stablyai.orca.ShipIt.*                 # parked copies; the daemon's is usually empty
```

`killall "Orca Helper"` clears it immediately at the cost of every live terminal; Manage
Sessions → Restart does the same from inside Orca.
