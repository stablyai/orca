# Native Diagnostic Dumps Research

Generated: 2026-07-04

Status: research baseline with branch implementation notes. Local diagnostics
export, local Crashpad capture, CLI/RPC wiring, and CIM-first Windows process
memory enumeration are implemented in this branch; binary upload and
symbolication remain separate future work.

## Executive Summary

Orca should treat this as two related systems, not one "exe dump" feature:

1. Native crash dumps: use Electron's `crashReporter`/Crashpad integration to collect minidumps for main, renderer, GPU, utility, and child-process crashes.
2. Support diagnostic bundle: create a user-reviewable ZIP that combines minidumps with redacted Orca context, OS summaries, memory snapshots, shell/WSL availability, and bounded event-log evidence.

Electron Crashpad is the only practical cross-platform native crash-dump layer. Windows WER/ProcDump, macOS `.ips` reports/sysdiagnose, and Linux core dumps are useful adjuncts, but they are platform-specific and should not be the primary Orca-owned contract.

The implemented CLI shape is `orca diagnostics bundle --output <filename-or-subpath>`, resolved under Orca's per-user logs/diagnostics directory rather than the installation directory. Installed app directories are often unwritable, code-signed, or replaced by updates.

## Current Orca Evidence

Orca already has a redacted diagnostic bundle workflow:

- `src/main/ipc/diagnostics.ts` registers `diagnostics:collectBundle`, retains main-collected payloads, and enforces the privacy/consent boundary before upload.
- `src/main/observability/bundle.ts` emits NDJSON with a header and redacted span lines, capped at 4 MiB.
- `src/main/observability/diagnostic-bundle-upload.ts` only uploads `application/x-ndjson`, so it is not ready for binary minidumps or ZIP bundles.
- `src/main/ipc/crash-reporting.ts` attaches the existing diagnostic bundle to crash reports, using a longer lookback window.
- `src/shared/crash-reporting.ts` already records app version, platform, OS release, arch, Electron, and Chrome versions for captured process-gone reports.

Orca already has a CLI diagnostics surface, but only for memory:

- `src/cli/specs/diagnostics.ts` exposes `orca diagnostics memory`.
- `src/cli/handlers/diagnostics.ts` calls runtime RPC method `diagnostics.memory`.
- `src/main/runtime/rpc/methods/diagnostics.ts` returns `runtime.getMemorySnapshot()`.

The packaged CLI path is viable for the bundle command:

- `resources/win32/bin/orca.cmd` runs the unpacked CLI through `Orca.exe` with `ELECTRON_RUN_AS_NODE=1`.
- `config/electron-builder.config.cjs` ships that Windows command under `resources/bin/orca.cmd`.

Branch implementation added `diagnostics bundle` coverage for CLI parsing,
runtime RPC validation, bundle writing, and packaged Windows/macOS/Linux
launcher forwarding.

The pre-branch memory collector had a Windows gap:

- `src/main/memory/collector.ts` uses `wmic process get ProcessId,ParentProcessId,WorkingSetSize /format:value`.
- Microsoft marks WMIC deprecated and recommends PowerShell/CIM for WMI work, so the Windows enumerator should move to a PowerShell `Get-CimInstance Win32_Process` path with a narrow fallback.

Branch implementation moved Windows process enumeration to
`src/main/memory/windows-process-working-set.ts` with CIM JSON as the primary
path and WMIC retained as fallback.

## External Research Findings

### Electron And Crashpad

Electron's official `crashReporter` module is the app-level mechanism for native crash reports. It uses Crashpad, stores crash reports under the app's user-data `Crashpad` directory by default, and can be redirected with `app.setPath('crashDumps', path)` before the reporter starts. `crashReporter.start()` should run as early as possible, preferably before `app.on('ready')`, because renderers created before initialization are not monitored.

Useful Electron constraints:

- `uploadToServer: false` still collects and stores crash reports locally.
- `globalExtra` is the right place for static metadata such as app version, channel, platform, arch, and Electron version.
- `extra`/`addExtraParameter` values are string-only and size-limited.
- Main-process extra parameters do not automatically apply to renderer/child crashes unless they are in `globalExtra` or set in the crashing process.
- The upload payload includes `upload_file_minidump`, plus product/version/platform/process metadata.
- `getLastCrashReport()` and `getUploadedReports()` only describe uploaded reports, not merely local files on disk.

Crashpad's design docs explain why this should be treated as sensitive data. Crashpad snapshots process state out of process, writes minidumps, and can include modules, threads, registers, stack memory, command line, environment, and selected memory referenced from stacks or registers. That is useful for debugging but not redaction-friendly.

Symbolication is a separate requirement. Crashpad/Chromium documentation expects minidumps to be stackwalked and symbolized server-side with symbol files. Without a release-symbol pipeline for Orca, Electron, native modules, and bundled helpers, minidumps may still help with process state and module lists, but root-cause analysis will be much weaker.

### Windows

Windows has three relevant mechanisms:

1. WER LocalDumps can be configured under `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps` or a per-exe subkey. It is not enabled by default and requires administrator privileges to configure. Microsoft also says applications with their own custom crash reporting are not supported by this WER feature.
2. Sysinternals ProcDump can create minidumps, full dumps, triage dumps, dumps on exceptions, dumps on hangs, and dumps on performance thresholds. It is useful for support playbooks, but bundling or auto-downloading it creates licensing, trust, and AV-friction questions.
3. Windows 11 Task Manager can create live user-mode memory dumps manually.

For Orca-owned automation, prefer Electron Crashpad for native app crash dumps. Use Windows Event Log and CIM for supplemental summaries:

- `Get-WinEvent` can read Application/System logs and filter `Application Error`, `Application Hang`, and Orca-related records by time window.
- `Get-CimInstance Win32_OperatingSystem` can provide OS and memory details.
- WMIC should not be the default new implementation.

### macOS

macOS Console exposes user and system Crash Reports, Spin Reports, Log Reports, and Diagnostic Reports. Crash report names use `.ips`, spin reports use `.spin`, and diagnostic reports use extensions such as `.diag` or `.dpsub`.

Activity Monitor can generate:

- Sample Process reports.
- Spindumps for unresponsive apps.
- System Diagnostics reports.
- Spotlight Diagnostics reports.

These are valuable when a user is manually working with support, but they are too broad and privacy-heavy for default Orca upload. Orca should collect an index or bounded excerpts by default, and only include raw macOS reports when the user explicitly selects them.

### Linux

Linux crash-dump behavior varies by distribution and configuration:

- `systemd-coredump` can log crash summaries to the journal and store core files under `/var/lib/systemd/coredump/`.
- `coredumpctl` can retrieve and process saved dumps and metadata.
- `kernel.core_pattern` controls where kernel-generated core dumps go.
- `gcore` can create a core file from a running process without terminating it, but it depends on debugger availability and permissions.

For Orca, Linux native collection should still start with Electron Crashpad. A support bundle can optionally include `coredumpctl` metadata for Orca/Electron process names if available, but it must tolerate systems without systemd-coredump, without retained cores, or without permission to read them.

### Node And V8 Diagnostics

Node's `process.report` APIs can generate JSON diagnostic reports with platform, resource, stack, heap, and runtime details. Node/V8 heap snapshots can be useful for memory leaks, but Node documents that generating a heap snapshot can require about twice the heap size and blocks the event loop. Heap snapshots should therefore be opt-in, not part of the default bundle.

## Orca Architecture

### Layer 1: Native Minidump Capture

Add an early main-process crash reporter initializer:

- Create the crash-dump directory before starting Crashpad.
- Call `app.setPath('crashDumps', crashDumpDirectory)` before `crashReporter.start()`.
- Start with `uploadToServer: false` so Orca collects local dumps without silently uploading them.
- Add static `globalExtra` fields: `app_version`, `orca_channel`, `platform`, `arch`, `os_release`, `electron_version`, `chrome_version`, `schema_version`.
- Keep upload behavior behind the same user-facing privacy/consent setting as diagnostic bundles, with a separate "include native crash dumps" decision.

Recommended crash dump directory:

- Main app path: `path.join(app.getPath('logs'), 'diagnostics', 'crashpad')`, or a dedicated `userData/diagnostics/crashpad` path if the logs path is initialized too late.
- Do not use the installation directory.

### Layer 2: Diagnostic Bundle Export

Add an archive-oriented collector that can be used from UI, crash reporting, and CLI:

```text
orca diagnostics bundle [--output <filename-or-subpath>] [--lookback <duration>]
                        [--include <category>] [--exclude <category>]
                        [--json] [--open]
```

Default output is computed by the main process:

- macOS: `~/Library/Logs/Orca/diagnostics/orca-diagnostics-<timestamp>.zip`
- Windows/Linux: Electron's default logs path is inside `userData`, so use `app.getPath('logs')/diagnostics/orca-diagnostics-<timestamp>.zip`
- CLI fallback, when no main process is reachable, should either launch/connect to Orca or use conservative platform defaults and clearly label the bundle as "offline partial".

Archive layout:

```text
manifest.json
app/orca.json
app/runtime-counts.json
system/os.json
system/resources.json
diagnostics/observability.ndjson
crash/orca-crash-reports.json
crash/minidumps/*.dmp
memory/snapshot.json
windows/events.json
windows/wsl.json
windows/shells.json
macos/reports-index.json
macos/shells.json
linux/coredumpctl.json
linux/journal.json
linux/shells.json
```

Default category set:

- Include all low-risk, redacted, bounded categories by default.
- Include minidumps in local exports created by explicit user command or explicit UI action.
- Do not upload minidumps or attach them to auto-created issues without a separate explicit consent gate because minidumps cannot be meaningfully redacted after capture.

### Bundle Data Model

Minimum useful fields:

- App: version, channel, package version, Electron version, Chrome version, Node version, build environment if available.
- OS: platform, release, `process.getSystemVersion()` where Electron is available, arch, locale, CPU model/core count, total/free memory, load average when meaningful.
- Runtime counts: number of durable projects, configured project host setups, managed worktrees/workspaces, active terminal tabs/panes, local/SSH/remote runtime breakdowns.
- Diagnostics: current redacted NDJSON spans via existing `collectDiagnosticBundle`.
- Crash state: current crash-report store, process-gone details, crash breadcrumbs, recent Crashpad minidumps by timestamp.
- Memory: current `MemorySnapshot`, including app, host, and managed terminal subtree summaries.
- Shells: detected shell availability and default shell resolver result, without raw env dumps.
- Windows: WSL availability/distro summary and recent Application Error/Application Hang events filtered to Orca/Electron process names.
- macOS: recent `.ips`/`.spin` report index for Orca process names, not broad sysdiagnose by default.
- Linux: `coredumpctl` metadata for Orca/Electron process names when available, not raw cores by default unless explicitly requested.

Avoid by default:

- Raw terminal scrollback.
- Full environment variables.
- Git remotes with embedded credentials.
- Repository paths, workspace names, branch names, prompts, transcripts, or file contents.
- Full heap snapshots.
- Full sysdiagnose archives.

### Windows Memory Refactor

Replace `wmic` as the primary path:

- Add a focused Windows process enumerator module with a concrete name, for example `windows-process-working-set.ts`.
- Query PowerShell CIM, preferably as JSON:

```powershell
Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, WorkingSetSize |
  ConvertTo-Json -Compress
```

- Keep timeout, max-buffer, and parse-failure handling non-fatal.
- Keep `wmic` as a last fallback only if needed for older systems.
- Remove the need to grow `src/main/memory/collector.ts`; AGENTS.md forbids adding max-lines disables, and this file already has one.

### Issue And Upload Integration

Current Orca feedback/crash submission can include an NDJSON diagnostic bundle, but it does not support binary minidump or ZIP uploads. To attach dumps to support issues later:

- Add a binary attachment/token endpoint, or extend the existing endpoint with an explicit content-type and size policy for ZIP/minidump data.
- Store uploaded bundles as private support artifacts and include only a ticket/artifact ID in feedback text or provider issues.
- Keep provider-specific issue creation behind adapters. Do not build this as GitHub-only because Orca supports GitLab and other providers.
- Avoid `gh-attach`; repo instructions explicitly say not to use it.

## Testing Matrix

Unit tests:

- Crash reporter initializer calls `app.setPath('crashDumps', ...)` before `crashReporter.start()`.
- Crash reporter starts with `uploadToServer: false` unless a consented upload path is enabled.
- Bundle category selection includes default categories and honors `--include`/`--exclude`.
- Bundle manifest records every file, byte count, category, and skipped/error category.
- Redaction rejects raw paths, env variables, prompts, branch names, terminal output, and repo names in default summaries.
- Windows CIM output parser covers normal JSON, singleton JSON object, empty output, timeout, access denied, and malformed JSON.
- Existing NDJSON 4 MiB cap remains enforced for current upload path.

IPC/RPC/CLI tests:

- `orca diagnostics bundle --output <filename-or-subpath> --json` routes through a new runtime RPC method.
- Renderer cannot supply raw bundle bytes; main process collects and writes the archive.
- Output path is diagnostics-relative or main-computed; parent directories are created only under Orca logs/diagnostics.
- Missing main runtime returns a clear partial/offline error or produces an explicitly partial bundle.
- Existing `orca diagnostics memory` behavior remains unchanged.

Platform smoke tests:

- Windows packaged CLI creates a ZIP with `system/os.json`, `memory/snapshot.json`, and bounded `windows/events.json` when permissions allow.
- macOS packaged CLI creates a ZIP and tolerates missing `.ips` reports.
- Linux packaged CLI creates a ZIP and tolerates missing `coredumpctl`.
- Non-admin Windows event-log access failure is recorded as a skipped category, not a failed bundle.
- No minidump directory present is recorded as skipped, not failed.

Crash-path tests:

- `process.crash()` in a test-only app path produces a Crashpad file under the configured dump directory.
- Renderer `process.crash()` is captured when crashReporter starts before renderer creation.
- Crash report submission can reference a local diagnostic bundle or uploaded artifact ID without embedding binary data in issue text.

## Recommended Phasing

1. Done in this branch: archive-oriented diagnostic bundle design and schema.
2. Done in this branch: local-only Electron Crashpad initialization.
3. Done in this branch: `orca diagnostics bundle --output`, implemented through runtime RPC and main-process archive writing.
4. Done in this branch: Windows memory enumeration with CIM-first process collection.
5. Done in this branch: OS adjunct collectors for Windows events/WSL/shells, macOS reports index/shells, and Linux coredumpctl/journal/shells.
6. Future: binary upload/private artifact support if automatic issue creation or support upload is required.
7. Future: provider-neutral issue integration that links artifact IDs rather than embedding raw dump contents.

## Key Open Questions

- Where will symbols for release builds, Electron, native modules, and helper executables be stored and resolved?
- Should local minidump collection be always on after user opt-in, or only active when the diagnostics setting is enabled?
- Should `orca diagnostics bundle` auto-launch/connect to Orca when no runtime is running, or produce an offline partial bundle?
- What is the maximum acceptable bundle size for local export, support upload, and issue attachment?
- Which support system should own binary artifacts: the existing feedback endpoint, a new diagnostics endpoint, or provider-specific private attachments?

## Sources

- Electron `crashReporter`: https://www.electronjs.org/docs/latest/api/crash-reporter
- Electron `app.getPath`, logs, crashDumps, process-gone events: https://www.electronjs.org/docs/latest/api/app
- Electron process diagnostics APIs: https://www.electronjs.org/docs/latest/api/process
- Electron render-process-gone details: https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details
- Crashpad overview design: https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/doc/overview_design.md
- Crashpad handler docs: https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/handler/crashpad_handler.md
- Chromium crash reports and minidump workflow: https://www.chromium.org/developers/crash-reports/
- Microsoft WER LocalDumps: https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps
- Microsoft ProcDump: https://learn.microsoft.com/en-us/sysinternals/downloads/procdump
- Microsoft Get-WinEvent: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-winevent
- Microsoft Get-CimInstance/WMI samples: https://learn.microsoft.com/en-us/powershell/scripting/samples/getting-wmi-objects--get-ciminstance-?view=powershell-7.6
- Microsoft WMIC deprecation: https://learn.microsoft.com/en-us/windows/win32/wmisdk/wmic
- Apple Console reports: https://support.apple.com/guide/console/reports-cnsl664be99a/mac
- Apple Activity Monitor diagnostics: https://support.apple.com/guide/activity-monitor/run-system-diagnostics-actmntr2225/mac
- Linux systemd-coredump: https://man7.org/linux/man-pages/man8/systemd-coredump.8.html
- Linux coredump.conf: https://man7.org/linux/man-pages/man5/coredump.conf.5.html
- Linux core(5): https://man7.org/linux/man-pages/man5/core.5.html
- Linux gcore: https://man7.org/linux/man-pages/man1/gcore.1.html
- Node diagnostic report APIs: https://nodejs.org/api/process.html
- Node V8 heap snapshots: https://nodejs.org/api/v8.html
