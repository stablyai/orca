# Perforce integration

Orca can drive a Perforce (Helix Core) client workspace from the Source Control panel.

## How it is wired

- A Perforce workspace is added as an ordinary **folder** project (Add Project → folder). Orca does not add a new
  repository kind: when a local folder project sits inside a client workspace (`p4 info` reports a client whose
  root contains the folder), the Source Control tab appears and renders the Perforce panel instead of the
  "Git repositories only" message.
- Everything runs the `p4` command-line client on the machine that owns the folder. Install `p4` on `PATH`, or
  point `ORCA_P4_PATH` at the binary. Credentials come from your normal `P4PORT`/`P4USER`/`P4CONFIG`/ticket setup.
- **SSH-hosted folders work the same way.** The desktop app sends `perforce.*` requests over the existing relay
  connection and the relay runs `p4` on the remote host, so `p4` (and its login ticket) only has to exist there.
  A relay that predates this feature answers method-not-found; the app tells the user to reconnect the SSH target.

## Concepts mapped to the panel

| Panel section        | Perforce meaning                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default changelist   | Files opened in the default changelist; described and submitted from the box at the top                                                                                            |
| Changelist N         | Collapsible numbered pending changelists: edit description (pencil), Shelve, Unshelve, Revert shelved files, Submit (opened-only or shelved-only, not both), and Delete when empty |
| Modified, not opened | Files changed on disk but not checked out (`p4 reconcile -n`)                                                                                                                      |
| New files            | Files on disk that are not in the depot                                                                                                                                            |

Row actions: click to diff against `#have`; **Open** runs `p4 reconcile` (add/edit/delete as the disk dictates);
**Revert changes** reverts opened files, force-syncs modified ones, and deletes new ones. The header has Refresh and Get Latest (`p4 sync`).

Selection: Cmd/Ctrl-click toggles a row, Shift-click selects a range. Right-clicking a checked-out file (or the
selection) offers **Move to existing changelist** (a list of the other pending changelists, plus Default) and
**Move to new changelist…**, which asks for a description first and only then creates the changelist and moves the
files. The Unshelve button in the panel header restores any changelist's shelf by number (including another user's)
into the default or an existing changelist. The same right-click menu has **Shelf changes** (shelve the files, then
revert them) and **Revert changes**. Shelved files are listed as `S` rows: click diffs the shelf against the
workspace, and right-click offers **Open shelved file** and **Unshelve file**. Right-clicking a changelist offers
**Copy changelist number** and **Delete changelist** (drops the shelf, reverts opened files, deletes it).

Every one of these operations is also a `perforce.*` relay method, so SSH-hosted workspaces support them once the relay
on the host has been updated (reconnecting the SSH target redeploys it).

Saving a read-only workspace file from Orca's editor first runs `p4 edit` on it.

## Code map

- `src/shared/perforce/` — everything that runs `p4`: runner, tagged-output parser, detection, status/diff,
  mutations, changelists, and `PerforceBackend` (the full operation set). Shared so the relay can use it.
- `src/relay/perforce-handler.ts` — exposes `PerforceBackend` as `perforce.*` relay RPC (validates every argument).
- `src/main/perforce/` — picks the backend (local vs SSH relay) and routes diffs and read-only checkout.
- `src/main/ipc/perforce.ts` + `src/preload/api/perforce-*.ts` — `perforce:*` IPC; `connectionId` selects SSH.
- `src/renderer/src/components/right-sidebar/perforce/` — panel and detection hook.
- `git:diff` routes to `p4 print` for Perforce folders so the standard diff tabs work.

## Settings > Perforce

Preferences live in `GlobalSettings.perforce` (`src/shared/perforce/perforce-settings.ts`, always read through
`normalizePerforceSettings`). They cover the p4 path and `P4PORT`/`P4USER`/`P4CLIENT`/`P4CONFIG`/`P4IGNORE` overrides,
timeouts, panel section order and visibility, refresh interval, `#have` vs `#head` diffs, save-time checkout behavior,
the `E` tab marker, new-changelist defaults, submit and destructive-action confirmations, what happens to a shelf on
submit, and the AI description button.

The p4 runner is shared with the relay, so settings reach it through a request-scoped context
(`p4-settings-context.ts`): the desktop wraps local calls, and sends the same object with every `perforce.*` relay
request (`settings` param; relays that predate it use defaults). "Test connection" runs `p4 info` through
`perforce:info`. "Generate description" (`perforce:generateDescription`) runs the agent, model, and instructions from Settings >
Perforce (independent of Git AI Author), feeding it `p4 diff -du` of the changelist's opened files.
