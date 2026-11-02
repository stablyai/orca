# Linux sleep inhibitor lifetime regression

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/run-linux-lid-sleep-assertion-docker.mjs --baseline <git-ref>
```

The runner builds the selected baseline and current production `LinuxLidSleepAssertion`,
then runs both in a temporary Linux container with real systemd and logind. It checks
the actual sleep and lid-switch inhibitor, both helper processes, the application's
scope, and an unrelated canary. The baseline must leak after SIGKILL. The candidate
must release the lock and helpers after SIGKILL and after an explicit stop; stopping
the lock must preserve the application itself.

Docker must support privileged containers and writable cgroups. Docker Desktop runs
this inside its Linux VM. The runner removes its container and image afterward.
`--container <name>` reuses an existing systemd container without removing it.
`ORCA_DOCKER` and `ORCA_DOCKER_PLATFORM` override the executable and architecture.

This reproduces the orphaned `systemd-inhibit`/`sleep` pair in issue #19831's process
inventory. That pair keeps an otherwise empty scope and sleep lock alive; it does
not explain the separate multi-gigabyte workload peaks.
