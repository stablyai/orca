# orca-tcc-disclaim-exec

Tiny macOS exec shim that runs `<command> [args...]` in place with the
"responsible process" responsibility disclaimed
(`responsibility_spawnattrs_setdisclaim` + `POSIX_SPAWN_SETEXEC`).

Measured effect: a process spawned normally by an app inherits that app as its
responsible process, so every terminal program's protected-resource access
collapses into Orca's bundle identity. Exec'd through this shim, the target —
and each of its descendants — is instead its **own** responsible process, so
tccd keys grants to each terminal program's own code identity and they persist
across launches (#9756, #6996). Note the shim's own identity is not what grants
land on: `POSIX_SPAWN_SETEXEC` replaces the shim's image with the target, so the
shim is gone from the process by the time tccd sees anything.

The build embeds a dedicated, stable `CFBundleIdentifier`
(`com.stablyai.orca.tcc-disclaim-exec`) as a `__TEXT,__info_plist` section so
every `codesign --force` pass derives the same code identifier for the shim
binary. Without it codesign falls back to the filename plus a content hash
(`orca-tcc-disclaim-exec-<hash>`), which changes on every rebuild.

Build: `pnpm run build:tcc-disclaim-macos` (add `--single-arch` for a
host-arch-only dev build). Output:
`.build/release/orca-tcc-disclaim-exec`; packaged builds ship it at
`Orca.app/Contents/MacOS/orca-tcc-disclaim-exec`.

To confirm the disclaim took effect without root, have a process call
`responsibility_get_pid_responsible_for_pid(getpid())` (dlsym'd, self-query
only) **from a terminal Orca spawned**: the plain path reports Orca's pid, the
shim path the caller's own pid. The check only discriminates under an app-bundle
ancestor — run from an ordinary login/SSH shell (already its own responsible
process) both paths report the caller's own pid, i.e. a false positive.

Runtime wiring is flag-gated behind `ORCA_MACOS_TCC_DISCLAIM` (default off —
the login(1) wrap in `src/main/providers/macos-tcc-login-shell.ts` remains the
live path). See `src/main/providers/macos-tcc-disclaim-exec.ts`.

Setting the flag needs a **fresh daemon**, or it silently does nothing: PTYs are
spawned by the detached daemon, which inherits the env of the GUI that forked it.
Quitting Orca only asks the daemon to retire when it hosts zero sessions
(`shutdownIfIdle`), so a relaunch with any warm terminal adopts the old,
flag-less daemon. Close every terminal before quitting, or kill the daemon. Also
launch the app from a shell — a Finder/Dock launch carries no shell environment.
Note the engaged log line reaches a console only on in-process (degraded/local)
spawns, since the daemon forks stdout to `'ignore'`; it is not a usable
flag-on confirmation for the normal daemon path.
