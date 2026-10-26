# macOS terminal permissions across updates

Read this before changing how the packaged macOS terminal daemon is launched, copied or cleaned
up, or before treating a missing executable as a permission denial. Background: issue
[#13921](https://github.com/stablyai/orca/issues/13921); the signed native evidence is in PR #25848.

## Why a signed copy started by launchd

A daemon forked from the app runs as `Orca Helper` and macOS charges its privacy access to the app
at its original path. While an update replaces that path, a daemon that first touches a protected
file is denied, and the denial persists after the new bundle arrives even though System Settings
still shows the grant. A missing executable alone does not cause it: a daemon that already read
protected files keeps working after its old executable is deleted.

So a packaged macOS GUI app starts its daemon from a private copy that the updater never touches:

- Each packaged macOS app ships a signed helper, `Contents/Helpers/Orca Terminal Host.app` (about
  124 MiB): the pinned Node from `src/shared/node-runtime-pin.ts` as its main executable, the
  daemon's `out/main` JS and that slice's node-pty. `config/scripts/macos-terminal-host-bundle.cjs`
  builds and signs it in `afterPack`, boots it through one PTY round trip, and fails the build on any
  layout, Info.plist, OS floor, architecture or signature drift.
- `macos-daemon-bundle.ts` keeps one copy per helper build, named by the helper's CDHash, at
  `userData/daemon-host/macos/terminal-host-<cdhash>/app.noindex/Orca Terminal Host.app`. The helper
  is read from the bundle the running main process executes from, never the whole app. A present
  copy is reused as is. Otherwise the helper is cloned (APFS clone, regular copy otherwise) into a
  `.staging-<pid>-*` sibling, verified once with
  `codesign --verify --strict -R "=<app designated requirement>"`, and published with one `rename`;
  losing that rename to another publisher is fine. An app without the helper falls back to the
  fork.
- `macos-daemon-launchd.ts` runs the copy's Node on the copy's `daemon-entry.js` as a
  non-persistent launchd job, so the daemon has Orca's own identity rather than the UI process's
  replaceable path. The label is fixed per profile and protocol
  (`com.stablyai.orca.terminal.<profile hash>.v<protocol>`). Before bootstrap a stopped job with
  that label is booted out. A running job gets a bounded wait for shutdown and launchd retirement;
  a job still running afterward gets the retired-service recovery below for this protocol's label
  only, and stays fatal unless that recovery releases it; an unreadable job is fatal. `--entry-path` stays the installed
  app's entry, which the replacement preflight compares. The job file is 0600 and deleted right
  after bootstrap, because the environment may hold credentials. It sets
  `AssociatedBundleIdentifiers` to `com.stablyai.orca`, which is how a launchd job not installed
  through SMAppService names the app it belongs to for Local Network access. Readiness is the
  normal authenticated handshake, fenced by the launch nonce.

Node servers, SSH hosts, unpackaged builds, Linux and Windows keep the fork launcher. Adopting an
existing daemon never copies. Telemetry reports a daemon started from a copy as
`spawner_path_class=stable-copy`.

Only Developer ID builds exercise the helper path in practice. A local ad hoc build's designated
requirement is a cdhash, which the helper (a different binary) cannot match, so it falls back to the
fork.

## Why the helper is `com.stablyai.orca`

TCC records grants against the designated requirement, which for Orca is the identifier plus team.
Signing the helper with the app's own identifier lets it inherit every existing grant, including Full
Disk Access, which a user can only add by hand. A distinct identifier would be a new client: new
folder prompts naming it, and a new Full Disk Access row for every user.

## macOS floor

The helper's Node declares `LC_BUILD_VERSION minos 13.5`, which is also the helper's
`LSMinimumSystemVersion` and `NODE_RUNTIME_DARWIN_MINIMUM_OS`. Packaging fails if a Node pin bump
changes it. Below 13.5 the launcher returns before copying and the fork runs, so those Macs keep the
pre-#25848 behaviour; Orca itself still supports macOS 12.0.

## First launch

macOS takes about 1 s the first time a binary runs from a new path, so the first daemon of each
build starts that much slower; later daemons reuse the copy and pay nothing. During that first exec
the daemon's `/usr/bin/login` preflight can time out, and that one shell is spawned directly.

## Security

The helper is a signed "run any JS as Orca" binary: it honours `NODE_OPTIONS` and any script path,
and Electron's fuses do not apply to it. Orca's own binary already allows the same, because its
RunAsNode fuse is enabled, so the helper adds no new exposure.

## Fallback states

`launchMacDaemonFromStableBundle` returns null, and the launcher forks, only when no job from the
attempt can still claim the endpoint. It logs one `[daemon] macOS terminal host fallback reason=<…>`
line with `MacStableLaunchFallbackReason`: `prepare-failed` (helper, copy, signature or job file),
`deadline`, `bootstrap-refused` (launchd refused the job and it is absent), `exited-before-ready`
(the job stopped before answering), or `endpoint-taken` (another daemon owns the endpoint, which
the fork path then adopts normally). After `bootstrap-refused` or `exited-before-ready` the copy is
deleted if unused, so the next launch re-copies it. A timed-out bootstrap, or a job still running or
unreadable, throws: forking beside it could split the endpoint.

The stable attempt must hand off by `MAC_STABLE_LAUNCH_HANDOFF_MS` after the launch starts, so the
fork's own readiness wait and adapter install still fit the 60 s startup PTY gate. Preparation
shares one abort signal that ends early enough for bootstrap and the job's readiness wait to fit
too. A fallback after the handoff deadline throws instead of forking a daemon that would arrive
after the app has moved to local PTYs.

## Cleanup rule

After publishing or reusing the current copy, each launch starts one background collection (one at
a time per process). It deletes every other entry under `daemon-host/macos/`, older copies and
crashed staging dirs, once `lsof +D` over it reports no process. `lsof +D` exits 1 even when it
lists users, so only empty stdout counts as unused; any timeout, stderr, truncated output or other
exit code keeps the copy. Nothing else can run a non-current copy: only this app launches daemons,
and only from the current copy. Staging dirs named with this process's pid are skipped, since they
may still be copying.

## LaunchServices and Spotlight

The helper declares no links, documents or types, has a lower `CFBundleVersion` than the app and
`LSUIElement`, and was not registered in the signed spike, nested or copied. Copies sit in a
`.noindex` folder, which Spotlight skips, and Orca never registers them. Starting the daemon through
launchd leaves no record, but another process running the copy's executable directly can make
macOS register it, so retirement runs `lsregister -u` on the bundle before deleting it.

The helper's main-executable UUID is Node's, shared by every official Node 24.21.0 binary of that
architecture, so it is not unique to Orca. Local Network access still passed in the signed spike:
macOS matched the client by its code signature, and the job's `AssociatedBundleIdentifiers` ties it
to Orca. Do not register copies explicitly (`lsregister -f` or `LSRegisterURL`).

## Rollback

To turn this off, make `launchMacDaemonFromStableBundle` (`macos-daemon-launchd.ts`) return `null`
right after its platform checks: every launch then takes the fork path. Copy-launched daemons that
are still running are adopted as usual. Copies are only deleted by the collection, so keep it running
there (`retireOtherMacDaemonCopies(root, '')`) until no copy-launched daemon can remain; each copy
keeps about 124 MiB.

## Existing sessions and status

RPC and signal shutdown share a five-second process-exit deadline, armed before terminal teardown.
A stalled teardown must not leave the endpoint retired while the launchd job stays alive forever.

An explicit, untargeted Restart also recovers signed-helper jobs left by older builds after they
retired their PID record and endpoint but failed to exit. Recovery uses exact launchd labels and
arguments for this profile, ignores newer protocols, and preserves live or unreadable endpoints
and services still publishing a PID record. It verifies descendant exits before killing the old
root and releasing its label. A failed recovery is logged without blocking the current daemon's
restart. A launch runs the same recovery only for the current protocol's label, and only once that
label still blocks bootstrap after the retirement wait (#29361); otherwise the label refused every
new terminal until a manual Restart. Node/SSH hosts do not perform GUI-service recovery.

Running old daemons keep their terminals; settings reports app and terminal-host Full Disk Access
separately, and a denied terminal is recovered by closing it or restarting the daemon. The packaging
hook also gives the main bundle and every Helper the Desktop, Documents and Downloads descriptions,
because the fork fallback still hosts terminals in `Orca Helper`.
