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
- `macos-daemon-bundle.ts` copies that helper, never the whole app, from the bundle the running
  main process executes from (APFS clone, regular copy otherwise) into
  `userData/daemon-host/macos/runtime-*/app.noindex`, then requires `codesign --verify --deep
--strict` to pass and the copy's designated requirement to equal the running app's. An app
  without the helper falls back to the fork.
- `macos-daemon-launchd.ts` runs the copy's Node on the copy's `daemon-entry.js` as a unique,
  non-persistent launchd job, so the daemon has Orca's own identity rather than the UI process's
  replaceable path. `--entry-path` stays the installed app's entry, which the replacement preflight
  compares. The job file is 0600 and deleted right after bootstrap, because the environment may hold
  credentials. It sets `AssociatedBundleIdentifiers` to `com.stablyai.orca`, which is how a launchd
  job not installed through SMAppService names the app it belongs to for Local Network access.
  Readiness is the normal authenticated handshake, fenced by the launch nonce.

Node servers, SSH hosts, unpackaged builds, Linux and Windows keep the fork launcher. Adopting an
existing daemon never copies. Telemetry reports a daemon started this way as
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

On the first exec of a freshly installed helper, the daemon's `/usr/bin/login` preflight can time out
while macOS assesses the new binary. The daemon then spawns that one shell directly; later shells use
`login` as usual.

## Security

The helper is a signed "run any JS as Orca" binary: it honours `NODE_OPTIONS` and any script path,
and Electron's fuses do not apply to it. Orca's own binary already allows the same, because its
RunAsNode fuse is enabled, so the helper adds no new exposure.

## Fallback states

The fork launcher runs only when no job from the attempt can still claim the endpoint
(`MacDaemonStableLaunchUnavailableError`): copy, signature, plist or deadline failure before
bootstrap; launchd refused the job and it is absent; the job stopped before answering; or another
daemon owns the endpoint, which the fork path then adopts normally. A timed-out bootstrap, or a job
still running or unreadable, stays fatal: forking beside it could split the endpoint.

The stable attempt must hand off by `MAC_STABLE_LAUNCH_HANDOFF_MS` after the launch starts, so the
fork's own readiness wait and adapter install still fit the 60 s startup PTY gate. Preparation
shares one abort signal that ends early enough for bootstrap and the job's readiness wait to fit
too. An unavailable verdict after the handoff deadline is reported as a launch failure instead of
forking a daemon that would arrive after the app has moved to local PTYs.

## Cleanup rule

Each copy holds a 0600 `job.json` with its job label, producer PID and whether bootstrap succeeded.
It is written before copying, so a crash mid-copy still leaves a claimable copy. Each launch starts
one background collection (one at a time per process) that retires a copy only when:

1. it was submitted, or its producer is confirmed exited, and
2. its job is missing, or stopped and successfully unregistered, and
3. `lsof +D` over the copy completes and reports no open file, executable or mapped library.

Any timeout, permission error, warning or truncated output keeps the copy. Explicit shutdown
unregisters the job, then applies rule 3. Cleanup never reads sockets, tokens or PID records.
Collection matches the directory, not the bundle inside it, so copies made before the
`app.noindex` folder (`runtime-*/Orca.app`) retire, and classify as `stable-copy`, the same way.

## LaunchServices and Spotlight

Copies made by earlier builds of this change are full app bundles, which Spotlight would list as a
second Orca and macOS could register as another `com.stablyai.orca` that claims `orca:` links and
Markdown/CSV files. The helper declares no links, documents or types, has a lower
`CFBundleVersion` and `LSUIElement`, and was not registered in the signed spike, nested or copied.
Copies still sit in a `.noindex` folder, which Spotlight skips, and Orca never registers them.
Starting the daemon through launchd leaves no record, but another process running the copy's
executable directly can make macOS register it, so retirement runs `lsregister -u` on each bundle
before deleting it.

The helper's main-executable UUID is Node's, shared by every official Node 24.21.0 binary of that
architecture, so it is not unique to Orca. Local Network access still passed in the signed spike:
macOS matched the client by its code signature, and the job's `AssociatedBundleIdentifiers` ties it
to Orca. Do not register copies explicitly (`lsregister -f` or `LSRegisterURL`).

## Rollback

To turn this off, make `launchMacDaemonFromStableBundle` (`macos-daemon-launchd.ts`) return `null`
at its first line: every launch then takes the fork path. Keep the rest, above all the
`retireAbandonedMacDaemonBundles` call in the launcher's `finally` and
`macos-daemon-bundle-retirement.ts`, until no copy-launched daemon can remain. Copy-launched
daemons that are still running are adopted as usual, and their copies retire once their jobs exit.
Never revert the cleanup: the old code never deletes copies, and each one keeps about 124 MiB (a
full-app copy from an earlier build, about 628 MiB) after an update removes the bundle it was cloned
from.

## Existing sessions and status

Running old daemons keep their terminals; settings reports app and terminal-host Full Disk Access
separately, and a denied terminal is recovered by closing it or restarting the daemon. The packaging
hook also gives the main bundle and every Helper the Desktop, Documents and Downloads descriptions,
because the fork fallback still hosts terminals in `Orca Helper`.
