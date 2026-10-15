# Perforce integration

Orca can drive a Perforce (Helix Core) client workspace from the Source Control panel.

## How it is wired

- A Perforce workspace is added as an ordinary **folder** project (Add Project → folder). Orca does not add a new
  repository kind: when a local folder project sits inside a client workspace (`p4 info` reports a client whose
  root contains the folder), the Source Control tab appears and renders the Perforce panel instead of the
  "Git repositories only" message.
- Everything runs the `p4` command-line client on the machine that owns the folder. Install `p4` on `PATH`, or
  point `ORCA_P4_PATH` at the binary. Credentials come from your normal `P4PORT`/`P4USER`/`P4CONFIG`/ticket setup.
- **Remote folders work the same way**, with `p4` (and its login ticket) needed only on the host that owns the folder:
  - On an SSH host that runs a managed Orca server (the default), and on a paired Orca server, the renderer calls
    that server's `perforce.*` runtime RPC methods, exactly as it calls `git.*` there.
  - On an SSH host that stays on the relay, the desktop sends the same `perforce.*` requests over the relay
    connection.
  - A host whose Orca build predates this answers without the `perforce.v1` capability (or method-not-found on a
    relay); the app asks the user to update Orca on that host (or reconnect the SSH target) instead of failing each
    call.

## Concepts mapped to the panel

| Panel section        | Perforce meaning                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default changelist   | Files opened in the default changelist; described and submitted from the box at the top                                                                                            |
| Changelist N         | Collapsible numbered pending changelists: edit description (pencil), Shelve, Unshelve, Revert shelved files, Submit (opened-only or shelved-only, not both), and Delete when empty |
| Modified, not opened | Files changed on disk but not checked out (`p4 reconcile -n`)                                                                                                                      |
| New files            | Files on disk that are not in the depot                                                                                                                                            |

Row actions: click to diff against `#have`; **Open** runs `p4 reconcile` (add/edit/delete as the disk dictates);
**Revert changes** reverts opened files, force-syncs modified ones, and deletes new ones. The header has Refresh and Get Latest (`p4 sync`).

The two unopened sections come from one `p4 reconcile -n -a -e -m -d` scan (`perforce-workspace-scan.ts`). Even a
preview takes the client's write lock and costs a server round trip per file (about 1.5 minutes for a large Unity
project), so scans of a folder never overlap, the next one waits three times as long as the last took, and status
answers from the last scan in between. A scan that fails or times out rests the same way, so a folder too large for
the timeout does not hold the lock scan after scan. Orca's own opens, reverts, submits and syncs make the next status
rescan. `-m`
skips the digest of files whose modification time matches the have list; in a workspace copy, whose have list comes
from `p4 flush`, it rarely can. Deleting a copy stops scans inside it first.

Selection: Cmd/Ctrl-click toggles a row, Shift-click selects a range. Right-clicking a checked-out file (or the
selection) offers **Move to existing changelist** (a list of the other pending changelists, plus Default) and
**Move to new changelist…**, which asks for a description first and only then creates the changelist and moves the
files. The Unshelve button in the panel header restores any changelist's shelf by number (including another user's)
into the default or an existing changelist. The same right-click menu has **Shelve changes** (shelve the files, then
revert them) and **Revert changes**. Shelved files are listed as `S` rows: click diffs the shelf against the
workspace, and right-click offers **Open shelved file** and **Unshelve file**. Right-clicking a changelist offers
**Copy changelist number** and **Delete changelist** (drops the shelf, reverts opened files, deletes it).

Every one of these operations is one entry of `PERFORCE_WORKSPACE_OPERATIONS`
(`src/shared/perforce/perforce-operations.ts`), so local, relay and Orca-server workspaces support the same set and
validate arguments the same way.

Saving a read-only workspace file from Orca's editor first runs `p4 edit` on it: automatically by default, or after an
in-app dialog (whose **Always open for edit** switches to automatic) when Settings › Perforce says to ask. The renderer does this before every write into a Perforce workspace, whichever host owns it
(`lib/perforce-checkout-before-write.ts`, which `App.tsx` registers as the write client's `setRuntimeFileWriteGuard`), and the editor loads a Perforce workspace's file diffs from `p4` rather than
Git (`runtime/runtime-worktree-file-diff.ts`). Both find the workspace that holds the file, even one opened from
another workspace, and detect a folder project not yet marked Perforce (a negative answer is kept five minutes).

Keyboard chords on the active Perforce file (editor or unstaged-diff tab): **Alt+P, Alt+E** opens it for edit (`p4 edit`),
**Alt+P, Alt+R** reverts its changes. `PerforceChordDetector` (`src/shared/perforce/perforce-file-chord.ts`) is a pure
two-step detector wired by `app-shell/use-perforce-file-chords.ts`; it only claims Alt+P when a Perforce file is active. The
shortcut registry supports single combinations only, so these are fixed rather than remappable.

**Workspace copies** (the Perforce counterpart of Git worktrees, on a Windows Dev Drive) are made and
removed from the project menu; see [perforce-workspace-copies.md](./perforce-workspace-copies.md).

## Code map

- `src/shared/perforce/` — everything that runs `p4`: runner, tagged-output parser, detection, status/diff,
  mutations, changelists, `PerforceBackend` (the full operation set) and `perforce-operations.ts` (the operation table
  every transport dispatches through).
- `src/main/ipc/perforce.ts` + `src/preload/api/perforce-*.ts` — `perforce:run` IPC for this desktop's folders and
  its relay-hosted SSH folders (`connectionId` selects SSH; `src/main/perforce/perforce-ssh-backend.ts`).
- `src/relay/perforce-handler.ts` — the same table as `perforce.*` relay RPC.
- `src/main/runtime/runtime-perforce-commands.ts` + `src/main/runtime/rpc/methods/perforce.ts` — the same table as
  `perforce.*` runtime RPC (`src/shared/rpc-contract/perforce-params.ts`), served by every Orca runtime.
- `src/renderer/src/runtime/runtime-perforce-client.ts` — routes a workspace the way Git routes it: IPC for this
  desktop, runtime RPC for a workspace an Orca server owns.
- `src/renderer/src/components/right-sidebar/perforce/` — panel and detection hook.

## Settings > Perforce

Preferences live in `GlobalSettings.perforce` (`src/shared/perforce/perforce-settings.ts`, always read through
`normalizePerforceSettings`). They cover the p4 path and `P4PORT`/`P4USER`/`P4CLIENT`/`P4CONFIG`/`P4IGNORE` overrides,
timeouts, panel section order and visibility, refresh interval, `#have` vs `#head` diffs, save-time checkout behavior,
the `E` tab marker, new-changelist defaults, submit and destructive-action confirmations, what happens to a shelf on
submit, and the AI description button.

Settings travel with each request and reach the p4 runner through a request-scoped context
(`p4-settings-context.ts`): desktop IPC applies this desktop's settings, and the relay and Orca-server methods apply
the `settings` param the client sends. Those omit the p4 path, client and P4CONFIG, which name things on the client's
machine. An Orca server fills them from its own Settings > Perforce (`perforceSettingsOnHost`), along with its
P4PORT and P4USER where the client leaves those empty, and a client that sends no settings (mobile, an older
desktop) gets the server's. Transports wait `perforceRequestTimeoutMs` (a status scan plus one command, or p4's own
limit for submit and sync) rather than their usual default, and Perforce calls to a server use their own RPC queue so
a long scan never holds the slots Git status needs.

"Test connection" runs `p4 info` (the `info` operation). "Generate description" (`perforce:generateDescription`, or
`perforce.generateDescription` on an Orca server) runs the agent, model, and instructions from Settings > Perforce
(independent of Git AI Author), feeding it `p4 diff -du` of the changelist's opened files.
