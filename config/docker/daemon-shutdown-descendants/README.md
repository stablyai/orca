# Daemon shutdown descendant regression

Run from the repository root with Docker running:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/run-daemon-shutdown-descendants-docker.mjs
```

The runner bundles the production `TerminalHost` and native PTY wrapper from the working tree. By default it runs the candidate only. Pass `--baseline <git-ref>` to add a red/green run; the baseline loads the five teardown modules from that ref without changing the checkout. Both run in Linux with `node-pty` 1.1.0.

A live PTY shell owns a child that called `setsid` and ignores `SIGTERM`. The fixture verifies those relationships, calls `host.dispose()`, and immediately exits its process. A separate supervisor checks that the child has stopped, an unrelated canary is still running, and shutdown finished within the daemon's five-second limit. The baseline must leave the child running; the candidate must stop it.

`ORCA_DOCKER` overrides the Docker executable. `ORCA_DOCKER_PLATFORM` overrides the Linux architecture. The test creates a temporary image and removes it afterward.

This proves cleanup of descendants still parented beneath a live shell at shutdown. It does not prove cleanup of processes that had already reparented before shutdown, or reproduce systemd-oomd policy decisions.
