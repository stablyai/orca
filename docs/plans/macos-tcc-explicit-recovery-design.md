# STA-7948: macOS daemon folder-access mismatch — finalized plan

Status: finalized 2026-09-21 after live evidence on a production adopted daemon and PostHog field
data. Supersedes the 2026-09-14 helper-first design. No production code yet.
Evidence: [validation/README.md](validation/README.md) (sections "2026-09-21 live evidence" and
"PostHog field data").

## 1. What is settled

1. **The failure is real, common, and tied to app updates.** PostHog `daemon_pty_cwd_denied`
   (shipped in #18043, 2026-09-01) fires only when the daemon reports the cwd unreadable and the
   app can read it. In the 21 days to 2026-09-21 it fired for 1,438 users (5,674 events on
   Documents, 2,379 on Desktop, 369 on Downloads). 1,374 of those users were in a protected folder
   class, and 96% carried `app_version_match=different`, i.e. an adopted daemon forked by an
   older app build. That is 2.8% of the 50,876 users who adopted a different-version daemon.
   Denials recur: 528 users hit it on two or more days.
2. **The daemon's existing verdict detects it.** The field data above is produced by the
   current `accessSync(R_OK|X_OK)` check in `terminal-host-session-create.ts`, so no new daemon
   code is required to observe the failure on daemons that already ship that field. A separate
   grant-less launchd probe on this machine showed a different TCC mode on `~/Documents`
   (`access()` passes, `opendir` fails), so enumeration is the more faithful check and Layer A
   switches to it, but detection does not wait on that.
3. **A fresh daemon from the current app fixes most cases, not all.** Among denied users whose
   later history is visible, 151 stopped being denied after a same-version daemon appeared and
   68 were denied again even with a same-version daemon (about 69% versus 31%). The 31% need the
   folder grant itself repaired (`tccutil reset SystemPolicyDocumentsFolder com.stablyai.orca`
   and re-allow), which matches the one hands-on recovery on record.
4. **Daemon-spawned shells carry the daemon's effective grant.** On the production adopted
   daemon here (healthy), the daemon's verdict, a login-wrapped shell's `scandir`, and a control
   shell agreed on `~/Documents`, `/tmp`, and Full-Disk-Access-gated `~/Library/Safari`. The
   shells report themselves as their own responsible pid yet read Safari, which only
   `com.stablyai.orca` holds; `com.stablyai.orca.helper` has no TCC row. The login wrapper is
   unconditional in production (1,734 of 1,734 spawns `wrapped`).
5. **The user-visible symptom** (Slack, 2026-09-20): inside a workspace under `~/Documents`,
   `ls -lde .` works (stat only), `os.scandir('.')` and opening a file both fail with EPERM, and
   Codex starts then dies with "Operation not permitted" reading its cwd. Commands that do not
   touch the folder work. macOS 26.5.1.

## 2. Design

One layer. The previous helper probe is dropped (section 4).

**Daemon (hardening, not a prerequisite).** Replace `isCwdReadableByThisProcess` with real
enumeration: `fs.opendirSync(cwd)`, one `dir.readSync()`, `dir.closeSync()`. `EPERM`/`EACCES` →
`false`; `ENOENT`/`ENOTDIR`/anything else → `true`, exactly as today. Keep the wire field name and
type (`cwdReadableByDaemon?: boolean`). Runs where `accessSync` already runs.

**Main: evidence.** In `src/main/daemon/daemon-pty-session-spawn.ts`, next to the existing
`trackDaemonPtyCwdDeniedIfDiverged` call, record proven divergence in a new
`src/main/daemon/daemon-folder-access-mismatch.ts`: `{ canonicalPath, cwdClass, daemonIdentity:
{ pid, startedAtMs, launchNonce }, appSessionId, observedAtMs }`. The app-side comparison uses
the same `opendir`/one-`readdir`/`closedir` sequence (switch the telemetry emitter to it too).
Keep at most one entry per daemon identity; a later spawn that succeeds on that identity clears
it. `canonicalPath` is the cwd sent to the daemon; no `realpath`, no case folding. Local
current-protocol adapter only. Daemons that omit the field (pre-#18043) produce no evidence.

**Main: IPC.** Extend the existing `pty:management:macTccAttribution` handler to return
`{ health, folderAccessMismatch: { daemonScope: string, cwdClass } | null }`. Mirror the type in
`src/preload/api/pty-management-api.ts`; the web fallback returns `null`. No new channel.

**Fresh-daemon probe (main).** Once per recorded mismatch, and again on each poll while the
answer is not "yes", main forks a short-lived child the same way the daemon is launched
(`process.execPath` with `ELECTRON_RUN_AS_NODE`, via the shared child-process wrapper, not
detached) and has it enumerate the folder. That child carries the attribution a restarted daemon
would get, so its verdict answers "will a restart help?" before the user pays for one. 3 s
deadline, argv only, scrubbed env, single JSON line, anything else is `unknown`. Exposed on the
same poll as `freshDaemonAccess: 'allowed' | 'denied' | 'unknown'`.

**Renderer: toast.** Title, one sentence, one action, in `useMacTccAttributionSeveredNotice.ts`.
Once per scope per app session, where a scope is the daemon identity plus the folder class, so one
daemon denied a second folder raises a new toast that replaces the first; the X latches the scope (sonner's `onDismiss`, which also
fires for programmatic `toast.dismiss`, so the hook clears its scope before any programmatic
takedown and only counts a user's X as `dismissed`). No cancel button: every other toast in the
app dismisses through the X alone. The Fix action calls `event.preventDefault()`: sonner deletes
a toast after an action click without firing `onDismiss`, which would strand the phase at
`visible` and never re-raise; keeping the toast up behind the dialog also means cancelling the
dialog leaves the notice where it was.

> **Terminals can't read your Documents folder**
> macOS is blocking Orca's terminal service from this folder, so commands run there may fail
> until it's fixed.
> [Fix]

**Renderer: fix dialog.** Opened by Fix. A checklist with no buttons inside the steps; the footer
carries the active step's one action (small, like the sign-out dialog) beside a ghost Cancel. The
X is the only other way out, so there is no footer Close.

```
Fix access to your Documents folder
macOS is blocking Orca's terminal service from this folder.
  ○  Allow Orca under Files and Folders
       macOS will ask you to allow Orca again.            (denied state only)
  ○  Restart Orca's terminal service
       Open terminals and agents will restart.
                          [Cancel]  [Reset permission]    freshDaemonAccess === 'denied'
                          [Cancel]  [Restart]             freshDaemonAccess === 'allowed'
             [Open System Settings]  [Restart]            freshDaemonAccess === 'unknown'
                                     [Done]               after a successful restart
```

- `allowed`: step 1 is already green; the footer goes straight to Restart.
- `denied`: a fresh daemon is denied too, so Restart is not offered (it would spend every terminal
  for a predictable no-op). The primary action is **Reset permission**: main runs
  `tccutil reset <SystemPolicy{Documents,Desktop,Downloads}Folder> <app bundle id>`, then reads
  the folder itself (async `opendir`, so the blocking TCC prompt cannot stall main) so macOS
  prompts from the app, then forces the fresh-daemon re-probe. Allowed → step 1 turns green and
  Restart appears. A measured `denied` → "Still blocked after the reset." and the buttons stay;
  an unanswered sheet or a probe that could not answer reports `unknown` to the dialog and to
  telemetry alike, so that line never shows without a verdict behind it. Reset
  failed or unsupported → "Couldn't reset the permission. Use System Settings instead." Open
  System Settings remains as the ghost fallback. Reset is offered only for the three TCC folder
  classes (`MAC_TCC_FOLDER_CLASSES`); a denial in `other-home`/`outside-home` has no row to
  reset, so Open System Settings takes the primary slot. The prompting read races a 60 s deadline:
  an unanswered sheet reports `reset_outcome_unknown` and releases the dialog instead of holding
  it busy for the session.
- `unknown`: step 1 shows "Couldn't verify. Skip if already allowed."; Settings stays reachable as the
  ghost button and Restart is offered, because an unanswered probe must not accuse the user.
- Step 1 also completes itself without the button: the poll re-runs on window focus, main
  re-probes, and the check mark appears when the fresh-daemon child can read the folder.
- Restart calls the existing `restartDaemon()` directly; the dialog already states the
  consequence, so it does not stack the Manage Sessions confirmation. Success is shown by the
  checklist: both steps green, footer Done, no sentence. Failure shows an inline line pointing at
  Manage Sessions.
- Copy rules learned in review: no hedged reassurance addressed to the user ("should work now");
  state is shown by the checklist, not narrated. No instruction the team has not verified: the
  "turn the toggle off and on again" line was cut for that reason.
- Agents come back on their own after the restart: the pane treats the synthetic exit as host
  loss, keeps its binding, and cold-restore types the agent's `--resume` into the fresh shell.
  Only a reply in progress is cut off, so the copy says "restart", not "close".
- The existing Manage Sessions confirmation copy is updated to match ("Open terminals and agents
  will restart. Terminals on remote hosts are not affected.").

**Recovery and clearing.** Evidence is keyed by daemon identity plus folder class; the dialog is
derived from the store and renders only while the latest verdict's scope equals the scope the
user opened; any verdict for another scope or for no scope clears `openScope`, so evidence that
moves or clears unmounts it and the same scope returning later never reopens the dialog on its
own. A null verdict, from the poll or from the reset's re-probe, retires the toast from inside the
store's `applyVerdict`, so no caller has to remember to. Busy labels read each button's own state;
the combined busy only disables. A restart replaces the identity,
so the next poll returns `null` and the toast is dismissed. If the replacement daemon is also
denied, the next spawn re-records, the toast returns, and the dialog reopens with step 1 unchecked.

**Telemetry.** `daemon_folder_access_notice` with `action: shown | fix_opened | settings_opened |
reset_clicked | restart_clicked | dismissed | restart_outcome_fixed | restart_outcome_still_denied |
reset_outcome_allowed | reset_outcome_still_denied | reset_outcome_unknown` and `cwd_class`. The
restart outcomes fire on the replacement daemon's first spawn in the same folder class, replacing
the PostHog proxy for "does a restart fix it". The reset outcomes come from the forced re-probe
right after the reset and are the first measurement of whether the documented recovery works for
the users a fresh daemon does not help. Keep `daemon_pty_cwd_denied` as the denominator.

**What is known about the stuck group (2026-09-21, corrected the same day).** By construction of
the trigger, every user who sees the notice already has the folder enabled for Orca; "not enabled,
enable it" describes nobody. Of 255 denied users later observed with a same-version daemon, 75
were denied again, but only 30 by that same-version daemon (all spawned from /Applications, all in
the same folder class); the other 45 were denied by yet another different-version daemon, i.e. the
bug recurring after a further update, which a restart fixes. So the group a restart cannot help is
about one in eight, not one in three. Two proxies remain: a "same-version" daemon can still be a
leftover from an earlier launch of that version, and "recovered" means only "no later denial
event". The PR's `restart_outcome_*` telemetry replaces both. No Settings action has been measured
to fix the 30. Candidate
remedies, none verified on an affected machine: toggle off/on, `tccutil reset` + re-allow, reboot.
Guaranteed workaround: a workspace outside Documents/Desktop/Downloads. The state cannot be
reproduced on demand (the 2026-09-01 signed-build matrix never produced it), so the reset step
ships gated behind the probe and is judged by its telemetry; G1 below is the other half.

**Reads never block an event loop.** Both the daemon's cwd verdict and the app's confirming read use the async enumerator; the app's is fire-and-forget on the spawn path because on macOS it is the read that raises the folder prompt, which holds the syscall until the user answers. The sync variant was deleted.

**Tests.** `terminal-host-cwd-readability.test.ts` for opendir mapping (EPERM, EACCES, ENOENT,
ENOTDIR, readable, empty). Evidence store: records only on divergence, one per identity, clears
on success or identity change, mints a new scope per folder class, ignores daemons without the
field. IPC shape. Reset: class gate, prompt deadline. Hook: toast once per scope, dismissal
latch, a replaced toast's dismissal ignored, clears when the poll returns `null`, no toast when both sides fail or the
path is missing. No Electron perf gate: nothing new runs on the spawn path beyond one `opendir`.

## 3. Open gate

- **G1 — one affected machine, oracle check.** Field data proves the daemon is denied; it does
  not prove the daemon's verdict and the terminal's experience always agree. The one hands-on
  case (Slack) agrees. Ask the affected user, inside the affected terminal:
  1. `python3 -c "import os; list(os.scandir(os.path.expanduser('~/Documents')))"` → expect EPERM.
  2. Settings → Terminal → Manage Sessions → Restart daemon. New terminal, rerun step 1.
  3. If still denied: `tccutil reset SystemPolicyDocumentsFolder com.stablyai.orca`, re-allow when
     prompted, rerun step 1.
  This confirms the copy, not the code.

Closed: G2 (population, above). G3 (prompt behaviour of the daemon's `opendir` on a signed build)
is folded into the Layer A PR's manual check.

## 4. Why the helper probe is dropped

It existed to observe daemons running code that predates the verdict. Every daemon that has
produced the field data above already ships the verdict, and daemons older than #18043 age out
with the next restart or reboot. A signed helper, PTY-launched probe, lease registry, and
second daemon client would buy coverage of a population that is already shrinking to zero.

## 5. Action items

1. Ship the design above in one PR against `main`. Owner: engineering.
2. Send G1 to the affected user (draft below). Owner: Jinwoo. Changes copy only.
3. After one release: read `daemon_folder_access_notice` against `daemon_pty_cwd_denied` to
   confirm the toast reaches the denied population, and watch whether the 31% re-toast rate
   holds.
4. Separately, reopen the prevention question with the field numbers: 2.8% of updaters losing
   folder access to their terminals is not a two-report curiosity. The durable-relocation design
   stays a separate doc.

Draft for G1:

> Hi Jinjing — for the Documents-folder terminal issue, could you run three quick things inside
> the affected Orca terminal and paste the outputs? (1)
> `python3 -c "import os; list(os.scandir(os.path.expanduser('~/Documents')))"`. (2) In Orca:
> Settings → Terminal → Manage Sessions → Restart daemon, open a new terminal, run (1) again.
> (3) Only if (2) still fails: `tccutil reset SystemPolicyDocumentsFolder com.stablyai.orca`,
> allow the folder when macOS asks, run (1) once more. Which step made it work tells us where the
> permission is breaking. Thanks!

## 6. Non-goals

Automatic restart, continuous polling, parsing arbitrary terminal output, Python or shell-command
fallbacks, failed-admission and restore triggers (the verdict exists only on a completed spawn;
a rejected folder-workspace admission is an app-side failure, not a mismatch), and any claim of
proven TCC corruption.
