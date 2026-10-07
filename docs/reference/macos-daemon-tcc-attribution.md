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

- `macos-daemon-bundle.ts` copies the whole bundle the running main process executes from (APFS
  clone, regular copy otherwise) into `userData/daemon-host/macos/runtime-*/app.noindex`, then
  requires `codesign --verify --deep --strict` to pass and the designated requirement to match the
  source.
  A partial copy carries neither the signature nor the frameworks the daemon needs.
- `macos-daemon-launchd.ts` runs the copy's main executable in Node mode as a unique, non-persistent
  launchd job, so the daemon has Orca's own identity rather than the UI process's replaceable path.
  The job file is 0600 and deleted right after bootstrap, because the environment may hold
  credentials. It sets `AssociatedBundleIdentifiers` to `com.stablyai.orca`, which is how a launchd
  job not installed through SMAppService names the app it belongs to for Local Network access.
  Readiness is the normal authenticated handshake, fenced by the launch nonce.

Node servers, SSH hosts, unpackaged builds, Linux and Windows keep the fork launcher. Adopting an
existing daemon never copies. Telemetry reports a daemon started this way as
`spawner_path_class=stable-copy`.

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

A copy is a full app bundle, so Spotlight would list it as a second Orca and macOS could register
it as another `com.stablyai.orca` that claims `orca:` links and Markdown/CSV files. Copies sit in
a `.noindex` folder, which Spotlight skips, and Orca never registers them. Starting the daemon
through launchd leaves no record, but another process running the copy's executable directly can
make macOS register it, so retirement runs `lsregister -u` on each bundle before deleting it.

Local Network access does not depend on LaunchServices: macOS identifies the client by its code
signature and main-executable UUID, which the clone keeps, and the job's
`AssociatedBundleIdentifiers` ties it to Orca. Do not register copies explicitly
(`lsregister -f` or `LSRegisterURL`): that makes them candidates for links and documents.

## Rollback

To turn this off, make `launchMacDaemonFromStableBundle` (`macos-daemon-launchd.ts`) return `null`
at its first line: every launch then takes the fork path. Keep the rest, above all the
`retireAbandonedMacDaemonBundles` call in the launcher's `finally` and
`macos-daemon-bundle-retirement.ts`, until no copy-launched daemon can remain. Copy-launched
daemons that are still running are adopted as usual, and their copies retire once their jobs exit.
Never revert the cleanup: the old code never deletes copies, and each one keeps about 567 MB after
an update removes the bundle it was cloned from.

## Existing sessions and status

Running old daemons keep their terminals; settings reports app and terminal-host Full Disk Access
separately, and a denied terminal is recovered by closing it or restarting the daemon. The packaging
hook also gives the main bundle and every Helper the Desktop, Documents and Downloads descriptions,
because the fork fallback still hosts terminals in `Orca Helper`.
