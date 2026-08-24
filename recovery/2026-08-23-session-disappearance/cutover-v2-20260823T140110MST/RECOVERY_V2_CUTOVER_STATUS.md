# Recovery-v2 cutover and first controlled recovery

Updated: 2026-08-23 14:12 MST

## Bottom line

Recovery-v2 is installed and running. The controlled upgrade preserved the surviving hourly
daemon, all 131 complete affected topologies that remain in tracked worktrees, and the exact
state-schema/protocol boundary. One affected local Codex session was then recovered in place: its
tab, layout, leaf, and logical PTY ID stayed unchanged, while Orca created one new daemon session
under that identity and resumed the saved provider conversation. The terminal is connected,
writable, and TUI-idle. No prompt was sent.

This proves that provider-backed recovery works on v2 for this incident shape. It does not prove
that every raw PTY survived, and it does not reconstruct arbitrary shell process state. Sessions
without provider metadata still depend on their preserved terminal history when the raw PTY is
authoritatively `exited`.

## Root-cause implications

This cutover is a control case against attributing the bulk incident to daemon PID `6835` stopping.
The newer v2 app retained the still-live hourly daemon PID `26391` across the bundle replacement,
despite the daemon's older build metadata, while preserving all 131 complete affected topologies
in tracked worktrees. Same-protocol app/daemon version skew is therefore supported and is not by
itself destructive.

PID `6835` becoming unavailable could strand raw PTYs that it actually owned, but absence from the
replacement daemon or from the current adapter registry is only a routing/authority failure. It
does not prove that another daemon generation's session exited. The frozen catalog reinforces this:
only 5 of 138 unverifiable primary PTYs have their latest event from `6835`; the other 133 have
their latest event from other daemon PIDs.

The first controlled recovery also separates logical recovery from raw-process survival. Orca
kept the old tab, leaf, layout, and logical PTY ID, but created a new session incarnation and
resumed the saved provider conversation. That is successful provider continuation, not
reattachment to or resurrection of the old PTY. Durable raw-session continuity still requires
exact daemon/session-incarnation routing and, across a true owner crash, a surviving holder of the
PTY master.

## Current live state

| Item | Observation |
|---|---|
| Installed app | `1.4.189-adhoc.20260823204916` |
| Build commit | `bd09097708c9` |
| Build ID | `1.4.189-adhoc.20260823204916-bd09097708c9-arm64` |
| App PID | `27511` |
| Runtime ID | `f5c43687-8851-4f0b-8222-1b4292caa125` |
| Runtime / graph | `ready` / `ready` |
| Surviving daemon | PID `26391`, unchanged since 2026-08-23 11:32:59 MST |
| Daemon build metadata | `1.4.189-hourly.202608231007`, protocol v36 |
| ShipIt | Still quarantined; no active `com.stablyai.orca.ShipIt` cache |
| Dynamic worktree inventory | 200 tracked worktrees, 72 live panes, 21 attached worktrees |

The live pane count is diagnostic only. Its change from 75 before cutover, to 71 immediately after
launch, to 72 after the controlled recovery is not a terminal verdict.

## Build verification

The arm64 release asset was downloaded from
`v1.4.189-adhoc.20260823204916` and independently verified before installation.

| Gate | Result |
|---|---|
| DMG SHA-256 | `b20fdafd6d4c17fdce8fa10ed6e9059786c454eeb956acb1b8e107ad94f9944a` |
| GitHub asset digest match | Pass |
| Version / commit | `1.4.189-adhoc.20260823204916` / `bd09097708c9` |
| Architecture | Thin arm64 Mach-O |
| Strict deep code-sign verification | Pass |
| Signing identity | Developer ID Application: Lovecast LLC |
| Team ID | `6CX3WHS9HZ` |
| Gatekeeper | Accepted, Notarized Developer ID |
| Notarization staple | Valid |
| State schema | 1; readable versions `[1]` |
| Daemon protocol | 36; attachable versions 1 through 36 |

The DMG container itself is unsigned, matching the earlier v1 recovery DMG. The app inside is the
signed, notarized, stapled trust boundary and passed every application gate.

## Cutover sequence

1. Captured app status, all worktree process summaries, the live profile, its SHA-256, and a
   deterministic recovery merge validation.
2. Staged the verified app at
   `/Applications/.Orca.recovery-v2-20260823T140110MST.bundle` and re-ran strict code-sign
   verification on the staged copy.
3. Normally quit v1 GUI PID `65542`. Daemon PID `26391` survived.
4. Before the bundle swap, the same external-launch race from the incident reproduced: the old v1
   bundle reopened as PID `96491` at 14:04:49 MST. No app swap had occurred.
5. Recorded that relaunch, normally quit PID `96491`, and immediately moved the old bundle out of
   `/Applications/Orca.app`. This removed the external actor's old-version launch target.
6. Captured a second, isolated post-quit profile. Its SHA-256 was
   `9bdd64cbfa764021149d281b8390797ed214916064628035db83b950c172d347`; the recovery
   validation used that exact hash and passed.
7. Atomically moved v2 into `/Applications/Orca.app` and launched the exact path.
8. Required the new version/runtime ID, `ready` runtime and graph, surviving daemon PID `26391`,
   unchanged incident topology counts, and continued ShipIt quarantine before recovery testing.

The prior v1 app remains recoverable at:

```text
/Applications/.Orca.pre-recovery-v2-20260823T140110MST.bundle
```

Do not run that backup against the current profile. Any rollback must restore the app and matching
profile snapshot together, with ShipIt still quarantined.

## Profile preservation result

The deterministic validation returned the same result immediately before and after v2 launch:

| Check | Before v2 launch | After v2 launch |
|---|---:|---:|
| Validation | pass | pass |
| Current layouts | 1001 | 1001 |
| Complete current incident topologies | 131 | 131 |
| Incident layouts restored by the candidate | 0 | 0 |
| Exited records retained because current state still references them | 3 | 3 |
| Proven-exited records excluded | 17 | 17 |
| Missing-worktree unified tabs represented only in the offline candidate | 7 | 7 |

The seven candidate-only records belong to the three previously removed worktrees. The offline
candidate was validated but was not applied; re-adding those rows while their directories are absent
would only invite missing-worktree cleanup to remove them again.

## First controlled recovery

### Target

| Item | Value |
|---|---|
| Worktree | `auto-e2e-tests-autofix-scheduled-ci-1h-run-9-20260822T0700` |
| Tab ID | `d6d43b87-9d6b-4c48-87cc-641719ecab8e` |
| Leaf ID | `4d1848a5-e6ae-4108-b59e-e049791b70d9` |
| Logical PTY ID | `@@a95190fc` under the full worktree prefix |
| Saved provider | Codex session `01a02a6a-01fc-74c2-b77a-1d1f674d66e0` |
| Historical verdict | `unverifiable`; latest frozen event was `session-created` on 2026-08-22 |
| Pre-activation runtime inventory | Zero terminal handles for this worktree |

The worktree had one affected pane, complete topology, a 69,916-byte frozen terminal-history record,
and a saved Codex provider session. It was selected to keep the live test isolated to exactly one
affected session.

### What happened

Activating the worktree caused Orca's normal cold-wake path to recover the provider session in the
preserved pane. The current daemon did not contain the old raw session, so it created one new session
under the same logical PTY identity and ran the recorded Codex resume command.

Evidence:

- Daemon `session-created` at `2026-08-23T21:09:32.690Z` for the exact old logical PTY ID.
- New process PID `88082`, parent daemon PID `26391`.
- New incarnation ID `761a724d-5d78-42c2-946b-8dd962f5a217`.
- Runtime handle `term_88f38ceb-d943-4c3c-8b36-b844616ad603`.
- `connected: true`, `writable: true`, and `terminal wait --for tui-idle` satisfied.
- The original conversation appeared and the provider session resumed.
- No prompt or terminal input was sent.

The core persistence object—layout, legacy tab, unified tab, leaf binding, and logical PTY ID—was
byte-identical before and after activation. The only expected persistence change in the captured
object was removal of the consumed sleeping/provider record. This was not a blank replacement tab.

### Important interpretation

This probe exercised authoritative-missing cold recovery, not the
`terminal_pane_owner_unverified` error branch. A fresh daemon session was correct for this verdict
because the current daemon authoritatively lacked the old session and a provider continuation was
available. The v2 owner-unverified branch remains covered by the focused 10-test renderer suite: it
keeps the old binding and does not fresh-spawn when ownership cannot be decided.

Do not conflate these outcomes:

- `live`: attach the existing raw PTY.
- `exited`: recover via provider continuation or preserved history; creating a new PTY is expected.
- `unverifiable`: keep the binding untouched and do not start a replacement solely from loss of
  contact.

The frozen incident verdict remains `unverifiable` because historical logs cannot prove what
happened to the old process. The live current-daemon recovery decision had stronger present-tense
evidence: that daemon did not own the session and could safely cold-recover it.

## What recovery can and cannot restore

- Provider-backed tabs can restore the conversation in the same visual tab, as this probe did.
- A provider resume does not resurrect the old raw PTY process; it starts a new PTY and asks the
  provider CLI to continue its saved session.
- Plain shell tabs with no provider record can restore scrollback/history, but arbitrary shell
  process state cannot be reconstructed after an authoritative exit.
- An owner-unverified pane must remain untouched. v2 now enforces that rule in the renderer as well
  as main.
- Remote and SSH panes require execution-host authority. Loss of contact is never evidence of exit.

## Safe continuation

1. Recover one worktree at a time. Do not open dozens simultaneously; each provider continuation
   consumes a PTY and may resume a previously active coordination session.
2. After opening a worktree, verify the old tab remains present and classify the result:
   existing raw attachment, provider continuation, preserved-but-unverifiable, or history-only.
3. Do not send a prompt automatically. Leave recovered agents idle until their old ownership and
   orchestration context have been reviewed.
4. If Orca shows the owner-unverified message, close/reopen only after recording the tab/leaf/PTY
   identity. On v2 the binding should remain unchanged and no blank shell should replace it.
5. Keep daemon PID `26391` and the ShipIt quarantine intact while recovery continues.
6. Do not batch-resume frozen provider claims. The live provider record is a recovery capability,
   not proof that its old raw process exited.

## Evidence index

| Evidence | Path |
|---|---|
| Pre-v2 status/worktrees/profile | `pre-status.json`, `pre-worktrees.json`, `orca-data.pre-v2.json` |
| Unexpected v1 relaunch | `unexpected-v1-relaunch-status.json`, `unexpected-v1-relaunch-process.txt` |
| Final isolated profile | `orca-data.post-second-quit.json`, `post-second-quit-profile.sha256` |
| Isolated merge validation | `post-second-quit-profile-validation/` |
| Post-v2 launch state | `post-v2-status.json`, `post-v2-worktrees.json`, `orca-data.post-v2-launch.json` |
| Post-v2 merge validation | `post-v2-profile-validation/` |
| Controlled recovery probe | `owner-unverified-probe/` |
| State after first recovery | `final-status.json`, `final-worktrees.json`, `orca-data.after-first-recovery.json` |
| Signed build artifact | `../guarded-build-v2/orca-macos-arm64.dmg` |
