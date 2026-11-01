# macOS installer scheduling

Electron's Squirrel launcher submits ShipIt to launchd without `ProcessType`.
The default `Standard` service receives daemon CPU and I/O limits. After Orca
quits, preparing thousands of bundle files can take minutes before any window
returns. Reopening Orca during that interval makes ShipIt cancel the update.

This N-API addon wraps `+[SQRLShipItLauncher shipItJobDictionary]`, adding only
`ProcessType: Interactive` to each emitted dictionary. Squirrel still submits
the job, handles authorization, validates signatures, replaces the bundle,
retries failures and owns relaunch. The executable path, arguments, Mach service
and KeepAlive settings remain unchanged. This applies to ordinary quits with a
staged update and supervised server installs, as well as Update & Restart.

The method is private to Squirrel. The macOS updater workflow loads the real
framework from the pinned Electron distribution and checks that only this key
changes. Unsupported signatures and load failures retain the original updater
and produce a diagnostic. Unexpected signal or payload shapes pass through
unchanged. Native compatibility probes cover those cases and mapping exceptions.
Both Mac architectures build during this check.

A source change in Electron's Squirrel dependency would be preferable long term.
This hook avoids rebuilding or replacing that dependency and can be removed once
Electron sets the service type itself. Changing a running PID with `taskpolicy`
did not reproduce the improvement from setting the launchd job type.

On macOS arm64, a real unmodified update took 75 seconds. Signed Orca 1.4.230
clone installs with Interactive scheduling took 8 seconds with a patched job
dictionary and 6 seconds through Squirrel's native job submission. These runs
used different cache conditions; they are local observations, not a controlled
benchmark or timing guarantee. The signed installer verified each bundle.

The first update into a build containing this fix still uses the previous app's
launcher. Faster scheduling starts with updates initiated by the fixed build.
