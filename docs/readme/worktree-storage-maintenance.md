# Worktree storage maintenance

Run one command from the repository to preview maintenance across its locally registered Git worktrees:

```sh
pnpm reclaim-space
```

In an interactive terminal, the preview offers `Apply this cleanup? [y/N]`; enter `Y` to apply it.
Redirected input or output remains preview-only. To apply without a prompt, use `pnpm reclaim-space --apply`.

Historical test caches are retained by default. After stopping cross-version tests in all this
repository's worktrees, preview the same selection with:

```sh
pnpm reclaim-space --tests-stopped
```

Answer `Y` to apply that preview, or use `pnpm reclaim-space --apply --tests-stopped` to apply directly.

The command reuses the historical test cache, Electron distribution, dev bundle, and Vite cache cleanup scripts.
It shares complete Electron distributions through the repository cache and removes idle
`out/electron-dev` bundles, which development rebuilds on demand. It also removes tracked
`.cache/vite` dependency caches unused for 30 days. With `--tests-stopped`, it also
removes stamped historical test checkouts and shared seeds older than 30 days; tests regenerate them when needed. It leaves source files,
worktree registrations and branches intact. The manual command also includes old dependency
installs and build output as described below. Reported sizes are
logical file data; APFS clones and hardlinks mean actual disk savings can be smaller.

Use `--release-cache-min-age-days 7` to shorten historical-cache retention, or `0` to select all
recognised completed historical checkouts. This age option applies only to test caches. Local
checkout age uses directory modification time, which ordinary reuse does not refresh. The
`--tests-stopped` flag acknowledges stopped tests; older harnesses cannot prove a completed
checkout is unused. Without that flag, historical caches are excluded from both preview and apply.
Cache cleanup skips symlinks, malformed stamps, future formats, and publication/copy locks.
See [release source sharing](./release-source-sharing.md) for the cache and locking details.

Vite dev servers record cache use at startup and shutdown. Cleanup retains recent caches,
caches owned by a live process, and caches whose ownership cannot be verified, including caches
created before tracking was added. A maintenance lock prevents cleanup racing with server startup.
Desktop and web caches are reclaimed together; the next dev launch regenerates them as needed.

Use `--repo DIRECTORY` to choose another local repository. Git's worktree list determines scope,
including registered worktrees outside Orca's workspace directory. Folder workspaces without Git
have no repository-wide sweep. These commands run on the local host: they do not inspect or delete
anything on SSH hosts. Run maintenance on the execution host when maintaining remote repositories.

## Old dependency installs and build output

Old generated files are included in the normal manual command. Stop apps, agents, package
installs, builds and tests in the repository's sibling worktrees before applying:

```sh
pnpm reclaim-space
pnpm reclaim-space --apply
```

This manual pass retains the selected repository worktree, the invoking worktree, and any
`--exclude-worktree` directory. It removes ignored, completely untracked `node_modules`, `out`,
`dist`, and `build` directories older than 30 days. Recognized package roots are the repository
root, `mobile`, `native/*`, `src/packages/*`, `cloud/apps/*`, and `cloud/packages/*`, each with a
regular `package.json`. It does not search arbitrary folders or the user's home directory.
Use `--generated-min-age-days 14` to shorten retention, or `0` to include recent generated
directories. Age is the directory modification time, not proof that an install is unused;
stop sibling work before applying even when its dependencies were installed long ago.

Preview leaves files in place. Apply rechecks Git tracking, parent paths, directory identity
and modification time before deleting. Symlinked directories, symlinked package parents, nested
repositories and directories containing tracked files are retained. Read-only generated
directories can be made writable for removal; hardlinked package files are never chmodded.
Source files, local changes, worktree registrations, branches, and shared pnpm stores remain
intact. Generated files are recreated by installing dependencies or rebuilding in that worktree.
APFS clones and hardlinks mean directory sizes can greatly overstate the actual space reclaimed.

The automatic worker never runs this pass. Machine-wide caches, Docker images/volumes, downloads and simulator data remain
outside this repository-scoped command.

## Keeping installs shared

Healthy Electron installs join the shared distribution cache during native dependency setup,
without waiting for an Electron upgrade. The manual command migrates older installs immediately.
Read-only Electron package directories are retained and reported as skipped. Cache publication
or copying failures are also reported as skipped rather than silently omitted.

`pnpm dev` and `pnpm dev-stable-name` start an automatic repository-wide Electron and Vite cleanup worker
in the background after the dev process starts. It never prompts or waits before launching the app.
The worktree being launched is excluded from Electron sharing, dev bundle removal, and Vite cleanup; active
sibling apps and recent unfinished builds remain protected by the existing bundle checks.
Background sweep output is suppressed; worker start or exit failures are reported without stopping dev. Set `ORCA_SKIP_DEV_STORAGE_RECLAIM=1` to opt out.
The worker finishes independently if the dev app exits, and each cleanup operation has a ten-minute limit.

Historical test cache cleanup runs only in the explicit manual command with `--tests-stopped`.
Automatic invocations exclude it because tests may still be importing source.
The repository lock prevents competing cleanup commands. Dev bundle removal checks active
processes and recent unfinished builds, then rechecks eligibility immediately before deletion.
An unreadable process table prevents removal.

To retain older bundles during a manual sweep, run the underlying command with an age limit:

```sh
node config/scripts/reclaim-dev-electron-bundles.mjs --min-age-days 7 --apply
```

That limit uses the bundle directory's modification time. The underlying command also accepts
`--exclude-worktree DIRECTORY` to protect an entire worktree. A missing exclusion path is an error;
filesystem aliases resolve to the same worktree. Neither option schedules cleanup.
