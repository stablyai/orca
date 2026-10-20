# Perforce workspace copies

The Perforce counterpart of a Git worktree: a second, complete copy of a stream workspace in its own
folder, with its own Perforce client on a stream of its own, listed in the sidebar under the Perforce
project. Agents (or people) work in a copy without touching the original workspace, as they do in a
Git worktree on a branch of its own.

## Requirements

- **Windows 11 24H2 or later** (build 26100+) and the workspace on a **ReFS volume**, normally a Dev
  Drive. There, Windows block-clones every copied file, so a copy of an ~80 GB Unity workspace takes
  about 1 GB until files change. On NTFS a copy would duplicate every byte, so Orca refuses.
- A **stream** client whose `P4CLIENT` comes from a **P4CONFIG file inside the client root**
  (`p4config.txt` with `P4CLIENT=...`). Each copy gets its own p4config naming its own client, and the
  check guarantees Orca acts on the folder's own client.
- A copy's own stream is a sparse stream (server 2024.1+). On older servers pick **Work directly on**
  in Create from.

The requirement is the host's, not the desktop's: the readiness check runs where the workspace is, so
a Mac connected to a Windows 11 SSH host (managed Orca server or relay) or paired with a Windows 11 Orca
server makes copies there. Everywhere else (macOS, Linux, older
Windows, a drive that does not block-clone) Perforce source control works as usual and a new
workspace shares the project folder. The UI says so before anyone tries: the Create workspace option
replaces its stream picker with the requirement when the host cannot make copies, and Manage Perforce
copies and Settings › Perforce › Workspace Copies state it with a **Set up a Dev Drive** link
(`PerforceCopyRequirement`).

## Perforce projects

A Perforce project is a folder project marked `vcs: 'perforce'` (`isPerforceRepo`). Orca marks it the
first time the sidebar syncs a folder project whose folder is inside a stream workspace
(`perforce:detectProject`), and never unmarks it: a server that does not answer is no evidence the
folder stopped being a workspace. It stays a folder project (`kind: 'folder'`) because older Orca
clients and paired hosts treat an unknown kind as Git.

## Using it

As every new workspace in a Git project is a worktree on a branch of its own, every new workspace in a
Perforce project is a copy on a stream of its own: **Create workspace** names the copy after the
workspace (`<root>.wt\<name>`, client `<client>_wt_<name>`, stream `<parent>_wt_<name>`) and starts its
agent there. **Create from** is the base, as a Git base branch: the workspace's stream by default, or
any stream in the depot (a searchable list), or **Work directly on** the workspace's stream without a
new stream. A line under it reports the readiness check (block cloning, free space, warnings). When the
drive cannot hold a copy, the line says so and the workspace shares the project folder instead. A create
submitted before the check answers waits for it, so it never asks a host that cannot copy for a copy.
Progress shows in the pending workspace row; a toast reports the disk the copy used and offers the
Unity binding line. The sidebar card shows the copy's stream where a Git card shows its branch.

The project menu (`…`) has **Manage Perforce copies…**: every copy of the workspace, including ones
made outside Orca in the same layout and leftovers (a folder whose client is gone, a client whose folder is
gone), each with Delete.

Deleting a copy, from the sidebar, the context menu or the manage dialog, always opens the Perforce
copy confirmation. It lists what is deleted and what is kept, and needs explicit opt-ins before it
reverts checked-out files, deletes shelves or ends programs that have the copy open. Programs are
found two ways: a path inside the copy on their command line (Unity, Rider, a code indexer),
and a handle open on the copy's folder or a folder up to two levels below it (a shell or
agent working there, an Explorer window, Unity Hub's watcher). The second asks the kernel's per-file
list (`FileProcessIdsUsingFileInformation`, what Restart Manager uses) through
`getProcessIdsUsingPaths` in Orca's patch of `@vscode/windows-process-tree`; it opens only the
folders, never another process, so it is not the handle walk security software scores as an attack.
Each folder costs the kernel a walk of every handle on the system (about 50 ms at 200,000 handles,
on NTFS and ReFS alike), so the check stops at 64 folders, shallowest first, and asks them on up to
eight threads: about 0.8 s for a Unity project's top two levels. A program holding only a deeper
folder is not named; the delete then refuses before touching Perforce and says a program has the
folder open. A shell and what it started show as one entry. The user closes them and chooses **Check again**, or
opts in to ending them. Consent covers the exact processes shown (pid and start time). Orca never
ends itself or Explorer, and leaves its own terminals out of the list because removal closes them.
The generic worktree delete, the CLI and batch delete refuse a copy
(`PERFORCE_COPY_GENERIC_REMOVAL_MESSAGE`).

Settings › Perforce › Workspace Copies: minimum free space (default 10 GB), leaving out Unity's
`Library/PackageCache`, and extra folders to leave out.

## How a copy is made

`createWorkspaceCopy` (`src/shared/perforce/workspace-copy/`):

1. **Check.** Windows build, the P4CONFIG binding, a stream client, `<root>.wt` not a junction, free
   space, and a **block-clone probe**: copy a 64 MB file next to the workspace with robocopy and check
   that free space did not drop by its size. Asking Windows whether a volume is a Dev Drive
   (`fsutil devdrv query`) needs an elevated shell; the probe measures the property copies rely on. The
   host remembers a volume's answer (a negative one for five minutes), since each probe writes about 256 MB.
2. **Copy.** `robocopy /E /COPY:DAT /DCOPY:DAT /MT:32` into `<root>.wt\<name>`, keeping timestamps so
   Unity does not reimport. Each Unity project's `Temp`, `Logs`, `obj` and editor lock files stay behind.
3. **Stream and client.** The copy's own sparsedev stream `<parent>_wt_<name>` (`stream -o -t sparsedev
-P <parent>` → `stream -i`), branched at the parent's latest change; an earlier copy's stream of the
   same name that kept submitted work is continued instead. Then `<client>_wt_<name>` from the source's
   spec (`client -o` → `client -i`) with the new Root and Stream.
4. **Adopt.** `p4 flush //<copy>/...` (or `@<source client>` when working directly on the workspace's
   stream): metadata only, nothing is downloaded. On another stream, the two have-lists' server digests
   name the files that differ, and only those are fetched.
5. **Clean up.** Files the source has open go back to the depot version; tracked files under skipped
   folders come back from the depot; files that changed while robocopy ran (a sync) are repaired.
6. **Rebind.** p4config files, Rider `.idea/**/workspace.xml` and Unity's `vcPerforceWorkspace` entry.
7. **Verify.** `p4 set P4CLIENT` inside the copy must name the copy's client from the copy's own
   p4config. Any failure rolls back the client, stream, folder and marker.

The result reports the copied bytes and the free space actually used (`space.cloned`). A Unity project
using Perforce version control needs one line run in the copy's editor
(`unityVersionControlBinding`); the success toast offers to copy it.

## How a copy is removed

`removeWorkspaceCopy` re-reads the copy's state (the confirmation may be minutes old) and refuses
open files, shelves or programs the user did not opt into. It stops Source Control scans in the
copy and ends the programs the user agreed to end. It moves the folder aside first: Windows will not
rename a folder a program has open, so a held copy is refused before Perforce is touched, and a
Perforce failure puts the folder back. Then `revert -k`, delete pending changelists (and their shelves
when chosen), `client -d`, the marker, and the copy's own stream when nothing was submitted to it (with
submitted work it is kept, and the confirmation says how to bring the work into the parent). The
folder is deleted in the background; a leftover `.removing-*` folder is retried by the next listing.
Before that, main stops file watchers and Orca terminals in the copy. It refuses a client whose Root
is not the expected copy folder, so it can never delete anything else.

## Copies made outside Orca

The layout and the client and stream names are a contract, and each copy has a marker file beside it
(`<root>.wt\<name>.p4-worktree.json`, schema 1): the copy's name, folder, client, stream and mode, its
source workspace, how its work goes back (`handBack`, for an agent working in the copy), the Unity
binding line, and `createdBy: "orca"`. Copies a script makes the same
way show up in Orca (the sidebar syncs once per session and from Manage), and such a script can find,
list and remove the ones Orca makes.

## Code map

- `src/shared/perforce/workspace-copy/`: the engine (create, list, preview, remove), its host seam
  (`workspace-copy-host.ts`: p4, robocopy, free space, process list), and tests against a fake server.
  `workspace-copy-operations.ts` names the project-level operations every transport exposes.
- `src/main/runtime/runtime-perforce-copy-commands.ts`: readiness, streams, project detection, sync and
  removal against the runtime's own store, the one implementation. Desktop IPC (`perforce:runCopy`,
  `src/main/ipc/worktrees/perforce-copies/`) hands its projects to the desktop's runtime, and an Orca
  server serves the same commands as `perforce.*` runtime RPC (`repo: "id:<repoId>"`).
- Making a copy is Create workspace: `perforce-copy-creation.ts` (in `src/main/perforce/`) makes it, and
  the desktop's `worktrees:create` (`perforce-copy-workspace-creation.ts`) or the runtime's
  `worktree.create` with `perforceCopy` (`runtime-folder-worktree-create.ts`) records the workspace.
  An Orca server gets the client's copy options in `perforceCopy.settings`, and the client waits up to
  an hour (`PERFORCE_COPY_REQUEST_TIMEOUT_MS`).
- `src/main/perforce/perforce-copy-backend.ts`: where the engine runs, on this host or over an SSH
  target's relay (`src/relay/perforce-copy-handler.ts`).
- `src/main/perforce/perforce-copy-worktrees.ts`: sidebar metadata (including the copy's
  `perforceStream`) for adopted and vanished copies.
- `src/shared/worktree/perforce-copy-worktree.ts`: copy worktree ids (`${repoId}::<root>.wt\<name>`).
  Folder-project listings, authorized roots, PTY rehydration and the runtime listing include them.
- `src/renderer/src/components/perforce-copies/`: the composer's Create from picker and readiness line,
  manage/delete dialogs, the success toast, the detect-and-sync hook. Each call goes to the host that
  owns the project (`runPerforceCopyOperation`, with the project's execution host).
