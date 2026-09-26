# Perforce integration

Orca can drive a Perforce (Helix Core) client workspace from the Source Control panel.

## How it is wired

- A Perforce workspace is added as an ordinary **folder** project (Add Project → folder). Orca does not add a new
  repository kind: when a local folder project sits inside a client workspace (`p4 info` reports a client whose
  root contains the folder), the Source Control tab appears and renders the Perforce panel instead of the
  "Git repositories only" message.
- Everything runs the `p4` command-line client on the machine that owns the folder. Install `p4` on `PATH`, or
  point `ORCA_P4_PATH` at the binary. Credentials come from your normal `P4PORT`/`P4USER`/`P4CONFIG`/ticket setup.
- SSH-hosted folders are not supported yet; detection is local-only.

## Concepts mapped to the panel

| Panel section        | Perforce meaning                                                                        |
| -------------------- | --------------------------------------------------------------------------------------- |
| Default changelist   | Files opened in the default changelist; described and submitted from the box at the top |
| Changelist N         | Numbered pending changelists, each with Shelve and Submit                               |
| Modified, not opened | Files changed on disk but not checked out (`p4 reconcile -n`)                           |
| New files            | Files on disk that are not in the depot                                                 |

Row actions: click to diff against `#have`; **Open** runs `p4 reconcile` (add/edit/delete as the disk dictates);
**Close** runs `p4 revert -k` (keeps local content); **Discard** reverts opened files, force-syncs modified ones,
and deletes new ones. The header has Refresh and Get Latest (`p4 sync`).

Saving a read-only workspace file from Orca's editor first runs `p4 edit` on it.

## Code map

- `src/main/perforce/` — `p4` runner, tagged-output parser, detection, status/diff, mutations.
- `src/main/ipc/perforce.ts` + `src/preload/api/perforce-*.ts` — `perforce:*` IPC.
- `src/renderer/src/components/right-sidebar/perforce/` — panel and detection hook.
- `git:diff` routes to `p4 print` for Perforce folders so the standard diff tabs work.
