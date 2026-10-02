# Retire obsolete GitLab known-host generations

Each successful `getGlabKnownHosts` probe previously stored a host-list array under a connection ID plus its SSH provider generation. Reconnecting under the same ID created a new entry while every earlier successful generation remained cached until an explicit preflight reset. The cache now keeps one successful generation per observed execution identity.

Async publication also uses the existing coalescer's `ownsKey()` and checks the current SSH generation. A result completing after reconnect, explicit reset, or replacement by a newer probe cannot recreate retired cache state. Original callers can still receive their own completed result. Explicitly remembered hosts, native/WSL separation, command routing and existing probe timeouts are preserved.

## Evidence

The runner bundles the actual cache, coalescer and parser. Only command-result and SSH-generation ports are controlled; it opens no SSH connection and runs no GitLab command. It reverses `fix.patch` in memory, verifies the original source hash, and compares that baseline against the unmodified current product source. Reports include product, dependency, regression-test and fixture hashes.

| Control | Original | Fixed |
| --- | --- | --- |
| Successful result arrays retained after 128 generations | 128 | 1 current array |
| Remembered result arrays retained after 16 generations | 16 | 1 current array |
| Delayed old-generation result after a successor answers | Still retained | Collectable; successor preserved |
| Explicit reset followed by old completion | Old result repopulates cache | Next lookup executes a fresh probe |
| Abandoned probe finishes after its replacement | Old host added to replacement cache | Replacement remains unchanged |
| Explicit reset after retention exercise | 0 original arrays retained | 0 original arrays retained |

Both phases preserve remembered-host updates while probes succeed or fail and isolate native, Ubuntu WSL, Debian WSL and two connection IDs. `results.json` records Node26.6; `electron-results.json` records installed Electron43.7 / Node24.21 running without an app window. Both runs pass all controls. This is compatibility evidence, not a historical packaged-binary reproduction.

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/gitlab-known-host-retirement/reproduce.cjs
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/gitlab/gitlab-known-host-retirement.test.ts src/main/gitlab/gitlab-known-host-probe.test.ts src/main/gitlab/gitlab-known-host-probe-wsl-fallback.test.ts src/main/git/coalesced-probe.test.ts src/main/gitlab/client-mr-auth-rate-limit.test.ts
```

For the installed macOS Electron binary:

```sh
ELECTRON_RUN_AS_NODE=1 ORCA_BACKGROUND_LAUNCH=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc docs/audits/gitlab-known-host-retirement/reproduce.cjs docs/audits/gitlab-known-host-retirement/electron-results.json
```

The runner is portable; that executable path is macOS-specific. Thirty-two focused tests pass, including eight new retention/lifecycle/scope controls. Running those eight against the original source produces six failures and two passing controls. Node typecheck, focused lint (including artifact type-aware/casting scans), and the changed-code quality gate pass. The original product module and reused coalescer match named main `291b4ddd6f1c1af480169885e0fda7f9c78ff053`.

## Limits and incident mapping

This removes small metadata retained across SSH generations. Distinct historical execution identities may still keep one entry each until reset; this change does not impose a new cache cap or alter connection/provider lifetime. One generation's host list remains input-sized.

The demonstrated accumulation requires changing SSH provider generations, so it cannot explain [#19831](https://github.com/stablyai/orca/issues/19831)'s reported all-local session. No affected-host observation ties it to another OOM report. The proof measures reachable result arrays, not RSS or gigabytes of incident memory.
