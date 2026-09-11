# Rolling a packaged Windows build back to an older release

The on-disk suite drives both builds' real `Store` over a real `orca-data.json`.
That leaves three things it cannot reach: electron-builder packaging, the boot
sequence that decides where userData lives and which cohort migrations run, and
a real userData directory. This page records what those add, measured rather
than assumed.

## The measurement

On Windows 11 `10.0.26200` (x64), two packages built from source on the same
host with `pnpm run build:unpack`, each from its own `node_modules`:

- **new** — the composed stack at `84e703ce97a`, 241 commits ahead of the tag
- **old** — the `v1.4.199` tag

Both ran headless against an isolated `--user-data-dir`; nothing touched the
real profile. State was written by the new build through its own packaged CLI —
a repo, a worktree, a terminal tab — and an `ssh:*` host partition was injected
so the rollback could be asked about rows an old build did not write.

Every leg ran with a **same-version control** on a byte-identical copy of the
same state, because a restart mutates the session blob on its own and the
downgrade would otherwise be credited with that churn.

| question                                        | result                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| old build reads new state                       | yes — no throw, no salvage, no dropped row                           |
| old build writes back a shape new still accepts | yes — return leg diffs 0 keys removed, 0 added                       |
| old build deletes what it does not understand   | no — its diff matches the control except the running build's version |

`workspaceSessionsByHostId["ssh:*"]` tab rows survived all three legs, as did
`repos`, `projects`, `projectHostSetups`, `worktreeMeta`,
`worktreeIdentityAliases` and `worktreeMetaByIdentity`.

## Read the control, not the downgrade diff

A restart of **either** build on this state empties
`workspaceSession.unifiedTabs` and `tabGroups` for the worktree and drops
`tabGroupLayouts`, `activeGroupIdByWorktree` and the pane title under
`terminalLayoutsByTabId`. It also writes `_sortBySmartMigrated` and flips
`ui.sortBy` from `recent` to `smart`.

None of that is rollback behaviour — the same-version control produces the same
removals on the same input. Reading the downgrade diff alone reports terminal
tab-group loss that is not there.

An injected partition has to satisfy the session schema or both builds discard
it identically (`[persistence] Corrupt workspace session for host …, using
defaults`). A partition built field-by-field failed `activeRepoId: required`;
copying the whole local session and re-keying its worktree-keyed maps is what
makes the row survive long enough to be a test of anything.

## Two things a userData rollback cannot answer

- **The old-client empty-publish skew**
  (`workspace-session.ssh-host-partition-round-trip`) is a client/host wire
  disagreement: an older _client_ reads only the local partition and publishes a
  `replace-session` naming the workspace with no tabs. Reproducing it needs two
  paired runtimes, not one userData directory read twice.
- **Relay protocol-version negotiation** is likewise a wire surface. A packaged
  rollback with no pairing never opens a relay connection, so it exercises
  neither the version check nor its refusal path.

## Practical notes

- A packaged build takes Chromium's `--user-data-dir`; `configureDevUserDataPath`
  only overrides userData for dev and E2E, so an isolated profile needs no
  special build.
- `autoDownload` is off and `autoInstallOnAppQuit` is Linux-non-root only, so a
  packaged test instance will not install an update over the host's own app. Do
  not run the NSIS installer to obtain the old build — build the tag instead.
- Each packaged build copies itself to
  `%LOCALAPPDATA%\Orca\daemon-host\<version>` on first boot. That is outside the
  isolated userData and has to be cleaned up by hand; match the copy's
  `Orca.exe` hash against the build before removing one.
