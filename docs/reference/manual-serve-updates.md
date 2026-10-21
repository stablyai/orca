# Manual serve updates

Unsupported/manual `orca serve` installs expose optional
`runtime.remoteUpdateSupport.manualUpdate` data through `orca status --json`.
Human-readable `orca status` also prints the running version, detected install
method, release-check result, and operator instructions. Absence of this object
does not mean current. Supervisor-owned installs keep the existing native updater
and do not start this manual reporter.

The reporter starts after readiness and checks daily through Orca's existing
release feed and asset-readiness probes. Set `ORCA_SERVE_DISABLE_UPDATE_CHECK=1`
or `true` to disable this reporter's outbound checks, not the native updater. Values are case-insensitive and surrounding whitespace is ignored. Other values, including `0` and `false`, leave checks enabled. `disabled`,
`pending`, and `unavailable` do not mean current. Failed or not-ready checks clear
any previous release target and instructions. Only `update-available` carries them.

## Upgrade

Instructions are printed only, never executed. Stop or drain work before applying
an upgrade. Download the correct release artifact for the host architecture.
Package installs reuse Orca's package-command builder. Repackaged installs must
update through their own package manager, not through an Orca release artifact.

For an AppImage, download to a separate staging file, verify it, and preserve the
installed file's ownership and executable permissions when replacing it. Never
overwrite the mounted running image in place. For an extracted AppImage, extract
the new release into a separate directory and switch the existing launcher to it.
Follow the installation's existing service or wrapper configuration, retain its
data directory, and have that same owner stop and restart the runtime exactly once.
See https://www.onorca.dev/docs/remote-servers for supported server setup.

After restart, verify the reported running version and runtime readiness and
reconnect existing sessions. The manual reporter neither performs this verification
nor declares installation success. It never guesses a service name, asset filename,
or restart command.

## Provenance

The reporting, instruction, and CLI format implementation is adapted from
nwparker's PR #18129, head `19aac7ea3c9da9126e6b216e6280cc9cf1425d4a`.
This port keeps the current supervisor-owned updater, invalidates stale release
advice after unsuccessful checks, and leaves AppImage replacement to the operator.
