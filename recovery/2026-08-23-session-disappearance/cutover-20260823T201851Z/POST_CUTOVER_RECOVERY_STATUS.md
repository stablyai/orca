# Post-cutover recovery status

> Superseded on 2026-08-23 14:12 MST by recovery-v2. The v1 status below is retained as
> historical evidence. Recovery-v2 `1.4.189-adhoc.20260823204916` is installed, daemon PID
> `26391` survived, all 131 complete tracked incident topologies remained intact, and one
> provider-backed affected session was recovered in place without changing its core tab/layout/PTY
> binding. See
> `../cutover-v2-20260823T140110MST/RECOVERY_V2_CUTOVER_STATUS.md` for the current status.

Historical v1 snapshot updated: 2026-08-23 13:37 MST

## Bottom line

The guarded build prevents one false-exit path, but the terminal-session recovery is only partial
and a second destructive path remains. The renderer can clear an old PTY binding after an
owner-unverified attach error and then request a fresh shell, despite displaying a message that
the session was left untouched. Most affected panes remain `unverifiable`; do not open them until
the renderer reattach guard is installed.

Do not roll back the app, restart or kill daemon PID `26391`, restore the quarantined ShipIt
cache, or open affected panes. The installed guarded build is safe for the liveness probe but is
not yet safe for an owner-unverified reattach attempt.

## Live runtime

| Item | Observation |
|---|---|
| App | `1.4.189-adhoc.20260823201001` |
| App PID | `65542` |
| Runtime ID | `f73694d1-31b5-4abb-bc86-3123aae61783` |
| Runtime / graph | `ready` / `ready` |
| Surviving daemon | PID `26391`, started 2026-08-23 11:32:59 MST |
| Daemon build metadata | `1.4.189-hourly.202608231007`, protocol v36 |
| Dynamic terminal inventory at last check | 62 panes |

The terminal inventory count is dynamic and is not a recovery score. At the last check it still
omitted all paired/SSH hosts except `local`, and absence from the list is not evidence of exit.

## Incident recovery accounting

The frozen incident contains 138 primary sessions classified `unverifiable`, spanning 51
worktrees and 167 pane PTY IDs.

| Recovery state | Count |
|---|---:|
| Incident worktrees still tracked by Orca | 48 of 51 |
| Incident sessions in those tracked worktrees | 131 of 138 |
| Exact original PTY topology still present in the live profile | 130 of 138 |
| Original incident panes directly listed, connected, and readable | 3 panes in 1 worktree |
| Tracked sessions with a saved provider-session recovery record | 73 of 131 |
| Tracked sessions with preserved terminal history | 131 of 131 |
| Provider resume attempts performed | 1 |
| Successful provider resumes | 1 |

The three worktrees no longer tracked by Orca are:

- `create-scanning-issues`
- `sta-4062-folder-note-rollback`
- `sta-4064-phantom-folder-note`

They account for seven of the eight non-exact records. Their directories are absent, so removal
of their unified-tab reachability is consistent with missing-worktree cleanup rather than a new
false-exit verdict. Their frozen recovery evidence remains intact.

The eighth record is `deleting-skill`. Its two incident PTY bindings had already been replaced by
new blank-shell PTYs at 2026-08-23 12:13 MST, before the guarded cutover. The frozen catalog and
history still preserve its original primary PTY `@@b3d49597`; the current blank shells are not a
successful recovery of that session.

## Directly live incident panes

All three directly listed incident panes belong to
`auto-daily-prod-release-scan-run-18-20260821T1740`:

- `@@04230ccf`
- `@@fde1083b`
- `@@782038ec`

Each is connected, writable, and returned its original terminal screen. This proves that some
raw PTYs survived and reattached successfully, but it does not establish the status of the other
incident PTYs.

## Representative provider-session recovery

The tracked worktree `close-tab-on-mobile-back-to-prev` had two preserved incident tabs but zero
terminals in the live runtime graph. One tab had a saved Codex provider session:

```text
01a0068d-2be5-77b1-8a9e-cc7cda073fd2
```

The transcript still existed at its recorded path. A new Orca terminal was created in the same
worktree with:

```text
codex resume 01a0068d-2be5-77b1-8a9e-cc7cda073fd2
```

Result:

- New tab ID: `999334bc-5707-4631-909a-29c433d54414`
- New PTY: `@@1f02bf06`
- Runtime handle: `term_044c404a-b786-4ffe-93d8-98f39405b924`
- State: `live`, connected, writable, TUI idle
- Original prompt and conversation were visible
- No new prompt was sent

This is a successful provider continuation test. It does not revive the old raw PTY; it resumes
the provider conversation in a new terminal while leaving the uncertain old record preserved.
Because the raw PTY is still `unverifiable`, the new tab must not receive work until the old route
is proven `exited` or the user explicitly chooses to abandon that route. The test tab is idle and
received no new prompt.

## Why clicking the worktrees was still destructive

The installed patch changes only the liveness verdict used before visibility-resume
reconciliation: `null` remains `unverifiable` instead of becoming `false`/`exited`. When the old
daemon route cannot prove ownership, stable-pane attach throws
`terminal_pane_owner_unverified`. Main correctly avoids retiring persistence and the renderer
shows the retry message.

The renderer transport then converts that error into `onError(marker)` plus an undefined spawn
result. The connection layer treats every undefined reattach result as stale/dead, clears the leaf
binding and tab PTY ID, and starts a fresh spawn. Those fields are persisted. A later reopen may
therefore create a blank shell because the exact old ID has already been removed.

The required second guard is an explicit owner-unverified reattach outcome that reports the
toast but does not clear `terminalLayoutsByTabId`, `ptyIdsByTabId`, or the tab PTY ID and does not
fresh-spawn. Generic undefined reattach failures must keep their current behavior.

Relevant source boundaries at the guarded branch head:

- `src/main/ipc/pty.ts:878`: stable owner attach uses `attachOnly: true`.
- `src/main/ipc/pty.ts:900`: owner-unverified is translated without retiring persistence.
- `src/renderer/src/components/terminal-pane/pty-transport.ts:946`: spawn rejection becomes
  `onError(...)` plus an undefined result.
- `src/renderer/src/components/terminal-pane/pty-connection.ts:8273`: undefined reattach is treated
  as stale, clears bindings, and starts fresh spawn.
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx:1133`: leaf layout binding clear.
- `src/renderer/src/store/slices/terminals.ts:2474`: tab PTY/live-index clear.
- `src/renderer/src/store/session-write-subscriber.ts:180`: the changed session model is persisted.

## Safe next steps

1. Keep the current app and daemon PID `26391` running, but do not open affected panes.
2. Install a second guarded build that preserves bindings on
   `terminal_pane_owner_unverified`; validate it against a copied profile before resuming recovery.
3. Handle one provider claim at a time. Let guarded in-place attach win when it returns `live`.
   Resume into a new tab only after the old PTY is authoritatively `exited`, or after an explicit
   user decision to abandon the `unverifiable` raw route. Never send prompts automatically.
4. Export terminal checkpoints for the 58 tracked sessions without provider records. These can
   recover screen/history but cannot reconstruct arbitrary shell process state.
5. Recreate a deleted worktree only when its Git identity and desired base are independently
   known; never infer that identity from a PTY suffix.
6. Do not batch-resume `unverifiable` sessions. Before any approved recovery batch, create another
   consistent profile/evidence snapshot and use an idempotent ledger so retries do not duplicate
   resumed sessions.

## Rollback and preserved evidence

| Item | Location |
|---|---|
| Previous hourly app | `/Applications/.Orca.pre-recovery-20260823T201851Z.bundle` |
| Quarantined ShipIt state | `ShipIt.disabled/` in this cutover directory |
| Pre-cutover profile | `profiles.pre-cutover/local-default/` |
| Post-launch validation | `post-launch-profile-validation/RECOVERY_MERGE_VALIDATION.json` |
| Frozen incident catalog | `../../RECOVERY_CATALOG.json` |

Do not restore the old app and profile independently. Any rollback must treat the app bundle,
profile, and ShipIt state as one controlled operation.
