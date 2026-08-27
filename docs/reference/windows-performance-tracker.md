# Windows and WSL Performance Tracker

Last verified: 2026-08-08

This document is the durable queue for Windows performance work. The umbrella issue is
[#9300](https://github.com/stablyai/orca/issues/9300). Keep fixes measurement-first: add a deterministic
reproduction, record median and p95 where timing matters, verify correctness as well as latency, and
preserve native Windows, WSL, SSH, folder-workspace, and mixed-version behavior.

## Status at a glance

| Priority | Area                                   | Tracking                                                                                                                                                                    | Status                               | Next action                                                                                                         |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| P0       | WSL Git status and staging latency     | [#9284](https://github.com/stablyai/orca/issues/9284), [#9768](https://github.com/stablyai/orca/issues/9768), [PR #13207](https://github.com/stablyai/orca/pull/13207)       | Fix PR open                          | Land the measured shell-startup fix, then investigate DrvFS routing and linked-gitdir compatibility separately.    |
| P1       | Cross-cutting Windows/WSL measurements | [#9300](https://github.com/stablyai/orca/issues/9300), [PR #11261](https://github.com/stablyai/orca/pull/11261)                                                             | Open                                 | Establish the baseline matrix below and use interleaved comparisons for startup changes.                            |
| P1       | Clipboard staging-directory ownership  | [#12835](https://github.com/stablyai/orca/issues/12835), [PR #12917](https://github.com/stablyai/orca/pull/12917)                                                           | Fix merged; design follow-up unfiled | Move new staging files under one Orca-owned parent so cleanup never enumerates the shared temp root.                |
| P1       | WSL hook-relay startup reconciliation  | [#12900](https://github.com/stablyai/orca/issues/12900), [PR #13139](https://github.com/stablyai/orca/pull/13139)                                                           | Fix merged; design follow-up unfiled | Reconcile relays once from the live daemon-session inventory after the hook server starts.                          |
| P2       | Main-process child-spawn audit         | [#11161](https://github.com/stablyai/orca/issues/11161), [PR #12217](https://github.com/stablyai/orca/pull/12217), [PR #11698](https://github.com/stablyai/orca/pull/11698) | Known triggers fixed; audit remains  | Find remaining startup or periodic main-process spawns and measure event-loop gaps under injected spawn delay.      |
| P2       | Reverted accumulator protections       | [PR #10179](https://github.com/stablyai/orca/pull/10179), [PR #10255](https://github.com/stablyai/orca/pull/10255)                                                          | Unscoped                             | Audit current hot paths individually; file only narrow issues with a present-day deterministic reproduction.        |
| Monitor  | General embedded-TUI lag               | [#12446](https://github.com/stablyai/orca/issues/12446)                                                                                                                     | Closed as fixed                      | Reopen only with an exact version, agent, local/remote runtime, and captured frame/event-loop metrics.              |

Environment requirements:

- Real WSL required: Git hot-path benchmarking and hook-relay startup reconciliation.
- Native Windows sufficient: clipboard parent migration, blocking-spawn fault injection, capability
  probing, and startup measurements.
- Platform-independent unit work is not a substitute for real Windows/WSL latency evidence where a
  subprocess or filesystem boundary is the suspected cause.

## Completed fixes and evidence

### Port scanning under slow process creation

- Issue [#11161](https://github.com/stablyai/orca/issues/11161), fixed by
  [PR #12217](https://github.com/stablyai/orca/pull/12217).
- Endpoint-security software could delay `CreateProcessW`; even asynchronous Node process APIs perform
  process creation on the caller, freezing Electron's main event loop.
- Port-scan commands moved to a worker, command deadlines now begin after process creation, and the
  tests inject a real delayed spawn to pin UI responsiveness and false-timeout behavior.

### Repeated WSL and PowerShell capability probes

- Fixed by [PR #11698](https://github.com/stablyai/orca/pull/11698), merge commit `c3bf22b9a8`.
- Repeated synchronous `wsl.exe` and `pwsh.exe` probes could pause the main loop every 30 seconds.
- Capability reads are asynchronous and share one bounded 30 s → 60 s → 120 s backoff, followed by a
  five-minute ceiling check. A stable no-WSL session drops from 60 checks per consumer in 30 minutes to
  at most nine shared reads.
- Native Windows ABBA results:

| Command                  | Synchronous median / p95 event-loop gap | Asynchronous median / p95 gap |
| ------------------------ | --------------------------------------: | ----------------------------: |
| `wsl.exe --status`       |                          34.1 / 63.5 ms |                16.1 / 16.4 ms |
| `wsl.exe --list --quiet` |                          35.1 / 37.3 ms |                16.0 / 25.5 ms |
| `pwsh.exe -Version`      |                        103.0 / 312.9 ms |                18.9 / 25.8 ms |

### Startup hang while cleaning remote clipboard files

- Issue [#12835](https://github.com/stablyai/orca/issues/12835), fixed by
  [PR #12917](https://github.com/stablyai/orca/pull/12917), merge commit `595097b5fc`.
- A temp root with 1,232,261 entries produced approximately 1.23 million promises on the main process,
  causing a V8 microtask and garbage-collection storm.
- Cleanup now streams with `opendir`, filters foreign entries before scheduling work, and caps removals
  at eight. A native Windows Electron run remained responsive with 100,000 unrelated entries.

### Slow Codex hooks after Orca restart

- Issue [#12900](https://github.com/stablyai/orca/issues/12900), fixed by
  [PR #13139](https://github.com/stablyai/orca/pull/13139), merge commit `982570648a`.
- Daemon-backed WSL Codex sessions survived an Orca restart while their stable endpoint file retained
  the old main-process port and token. Each tool call could pay two stale-hook fallbacks.
- A local WSL PTY reattach now ensures the relay for the daemon-reported original distro. Native,
  fresh, SSH, blank, and unknown-distro cases are no-ops; the manager deduplicates per distro.
- Real Windows/WSL2 benchmark, using the generated Codex hook and production relay:

| Phase                 | Samples |     Median |        p95 |          Delivery |
| --------------------- | ------: | ---------: | ---------: | ----------------: |
| Stale endpoint        |      20 | 1,636.0 ms | 1,639.1 ms | timeout/fail-open |
| Refreshed on reattach |      20 |    58.5 ms |    61.9 ms |             20/20 |

### WSL login-shell overhead on Git reads

- Issues [#9284](https://github.com/stablyai/orca/issues/9284) and
  [#9768](https://github.com/stablyai/orca/issues/9768), addressed by open
  [PR #13207](https://github.com/stablyai/orca/pull/13207).
- WSL source-control reads repeatedly started a login shell. Slow profile scripts and banner output added
  latency and could contaminate Git's machine-readable output.
- The first read retains the login-shell behavior while a background per-distro probe captures Git's
  absolute path, `HOME`, and `PATH`. Later status, numstat, and upstream/config reads execute directly.
  Mutations, network operations, SSH, relay, native Git, and risky profile environments stay on the
  existing path. Transient probes retry; a successful login-shell fallback disables unsafe direct reads,
  while matching ordinary Git failures keep the fast path enabled.
- Real Windows 11/WSL2 ABBA results, with 3 warmups and 20 samples per natural-profile pair:

| Operation                    | Login median / p95 | Direct median / p95 |
| ---------------------------- | -----------------: | ------------------: |
| WSL-filesystem status        |     73.2 / 75.7 ms |      63.5 / 66.8 ms |
| WSL-filesystem stage+refresh |  221.1 / 234.8 ms |    203.3 / 207.0 ms |
| DrvFS status                 | 1,063.2 / 1,134.4 ms | 1,030.8 / 1,070.5 ms |
| DrvFS stage+refresh          | 1,272.7 / 1,318.8 ms | 1,225.3 / 1,246.4 ms |

- With a deterministic 250 ms login-profile delay, 2 warmups and 10 samples, native status fell from
  330.1 / 339.4 ms median / p95 to 64.5 / 67.7 ms. Every benchmark pair produced byte-identical stdout
  and stderr. The profile also emitted 106 bytes of non-Git banner text per login-shell invocation.

## Next investigation: WSL filesystem-host routing

PR #13207 removes avoidable shell startup but does not address the dominant cost for repositories on
`C:\`: Git traversing the tree through WSL's DrvFS mount. In the same fixture, Windows Git completed
status in 22.4 ms median versus approximately 1,031 ms through WSL/DrvFS.

Investigate whether read-only source-control operations should follow the filesystem host instead of the
selected terminal runtime. First prove equivalent status semantics across Git configuration, autocrlf,
symlinks, hooks, credentials, case behavior, worktree metadata, SSH/folder workspaces, and Git 2.25. Do
not route mutations or network operations until their environment contract is independently established.

Windows-created linked worktrees need a separate compatibility design: their `.git` files can contain a
`C:/.../.git/worktrees/...` gitdir that WSL Git cannot resolve. Path translation must be scoped to metadata
owned by the routed repository and must not rewrite arbitrary Git output.

## Architectural follow-ups

### Own the clipboard staging parent

PR #12917 makes shared-temp enumeration memory-safe, but enumeration time is still proportional to every
other application's temp entries. New transfers should use a structure such as:

```text
<os-temp>/orca-clipboard-files/<transfer-id>/...
```

Cleanup could then enumerate only Orca-owned children. Preserve a bounded compatibility sweep for legacy
top-level `orca-clipboard-file-*` directories, prove symlink and path containment, and benchmark against a
large foreign temp root before removing legacy handling.

### Reconcile WSL hook relays at startup

PR #13139 repairs the relay when one of today's PTY reattach paths runs. The desired-state design is:

1. Start the new main-process hook server.
2. Read the daemon's live local session inventory.
3. Group authoritative non-null WSL owners by distro.
4. Ensure and observe one relay per live distro.
5. Retain reattach-time ensure as a safety net for later sessions.

Only live sessions should participate; cold history or stale metadata must not boot a stopped distro.
Cover multiple panes in one distro, multiple distros, old daemons without WSL metadata, immediate hook
traffic, relay failure, and startup ordering.

### Continue the blocking-spawn audit

PRs #12217 and #11698 removed two proven main-thread freeze sources, not the entire failure class. Audit
main-process `spawnSync`/`execFileSync` calls and periodic asynchronous spawns whose process creation still
runs on the main thread. Prioritize startup, focus, polling, watcher, Git, and terminal-open paths. Use an
injected process-creation delay and event-loop-gap measurement; do not infer responsiveness from command
completion time alone.

## Measurement backlog

The baseline requested by [#9300](https://github.com/stablyai/orca/issues/9300) is still incomplete:

- open worktree → first useful Git status;
- idle child-process spawns per minute;
- watcher installation during a worktree switch;
- quick-open and search in a medium repository;
- PTY spawn, separated into process creation, environment/probe work, and first usable prompt;
- native `C:\` repo, WSL-filesystem repo, and `C:\` repo using a WSL project runtime;
- Defender/default endpoint security and a controlled excluded-worktree comparison.

[PR #11261](https://github.com/stablyai/orca/pull/11261) provides an open interleaved startup benchmark
with drift controls. [PR #11262](https://github.com/stablyai/orca/pull/11262) is a useful caution: its
bundle-size change did not show the initially suspected seconds-scale startup improvement once measured
interleaved. Do not quote blocked before/after startup medians when the machine itself can drift.

## Triage rules

- Attach an exact Orca version, Windows build, repository location, selected project runtime, and agent.
- Separate UI event-loop stalls from a command that is merely slow in the background.
- Prefer deterministic fault injection for hangs and interleaved samples for performance comparisons.
- Report median, p95, failures/timeouts, and correctness; a faster wrong result is not a win.
- Keep broad audits in #9300, but give every actionable root cause its own issue and narrowly scoped PR.
- Avoid another repository-wide performance or memory mega-PR. #10179 contained useful protections, but
  its 1,626-file scope was reverted by #10255; re-land measured fixes independently with focused tests.
