# Daemon scope lifetime regression

Run from the repository root with Docker running:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/run-daemon-scope-lifetime-docker.mjs --baseline <git-ref>
```

This starts real systemd and a user manager in a temporary Linux container. Docker must support privileged containers and a writable cgroup v2 mount. On Docker Desktop this uses its Linux VM. The runner removes its container and image afterward.

The baseline uses the production scope launcher from the selected Git revision. The candidate uses the working tree's production scope launcher and lifetime cleanup. A short-lived runtime launches each daemon and exits. Each daemon starts a worker through an intermediate parent that exits before daemon shutdown, leaving the worker already reparented to PID 1. The worker retains 24 MiB, ignores SIGTERM, and stays in the daemon's cgroup.

Four cycles cover graceful SIGTERM, SIGKILL, ordinary exit, and SIGKILL of the daemon's entire process group. The baseline must retain one additional worker each cycle. The candidate must return to zero workers and remove each old cgroup after every cycle. The report includes retained worker RSS and cgroup memory. Both must preserve the daemon and worker when only the runtime exits, and an unrelated canary in its own scope. The candidate must also preserve a scope whose daemon lacks exclusive ownership, and keep live work running if the lifetime pipe closes prematurely.

This proves the lifetime cleanup mechanism against real Linux process and systemd behavior. It does not reproduce a user's complete workload or assert that every reported OOM has this cause.

`ORCA_DOCKER` overrides the Docker executable. `ORCA_DOCKER_PLATFORM` overrides the Linux architecture.
