# Native Diagnostic Dumps Implementation Plan

Generated: 2026-07-04

Status: implemented in this branch for local diagnostics export. This file maps
the research in `docs/reference/native-diagnostic-dumps-research.md` to Orca's
current code seams and records the remaining deferrals.

## Target Outcome

Orca supports a cross-platform diagnostics export that can be created from the
packaged CLI and, later, from the app UI:

```text
orca diagnostics bundle [--output <path>] [--lookback <duration>]
                        [--include <category>] [--exclude <category>]
                        [--json] [--open]
```

The export creates a reviewable ZIP by default. A local, explicit export
includes all supported categories, including minidumps when available.
Upload or issue attachment must use a separate consent gate because minidumps
can contain process memory and cannot be reliably redacted after capture.

## Requirement Matrix

| Requirement                       | Pre-branch state                                                                                                                              | Branch state                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Native minidumps                  | No `crashReporter`/Crashpad integration found in source search.                                                                               | Electron `crashReporter` starts early with local-only `uploadToServer: false`, explicit crash-dump directory, and static crash annotations. |
| Redacted observability spans      | Existing `collectDiagnosticBundle` emits capped NDJSON.                                                                                       | Reuse the existing collector as `diagnostics/observability.ndjson` inside the ZIP.                                                          |
| Crash report context              | Existing crash-report records include app/platform/Electron/Chrome and process-gone details.                                                  | Include sanitized crash-report records plus links to matching Crashpad minidumps by timestamp/process where possible.                       |
| Memory snapshot                   | Existing CLI exposes `orca diagnostics memory` through `diagnostics.memory`.                                                                  | Include the current `MemorySnapshot` in every default bundle, and keep the standalone command unchanged.                                    |
| Windows process memory            | Current collector uses `wmic`.                                                                                                                | Windows process enumeration is CIM-first, with `wmic` retained only as a narrow fallback.                                                   |
| OS diagnostic info                | Existing bundle header only has app version/platform/arch/OS release/channel.                                                                 | Structured `system/os.json`, `system/resources.json`, and platform-specific summaries are exported.                                         |
| WSL/shell availability            | Not part of current bundle.                                                                                                                   | Bounded Windows WSL summary and shell availability summaries are exported without raw environment dumps.                                    |
| Workspace/project/terminal counts | Available through stores/runtime/CLI flows, but not in diagnostics bundle.                                                                    | Count-only runtime summaries are exported; raw names, prompts, branches, and paths stay out by default.                                     |
| Terminal lifecycle evidence       | `config/reliability-gates.jsonc` records a diagnostics-bundle gap, and `warnTerminalLifecycleAnomaly` currently only emits a console warning. | Compact terminal lifecycle breadcrumbs are recorded to crash diagnostics and bundle export coverage proves the trace file is present.       |
| CLI export                        | Only `orca diagnostics memory` exists.                                                                                                        | `orca diagnostics bundle` is wired through CLI specs, handlers, runtime RPC, and packaged launcher tests.                                   |
| Issue/upload integration          | Feedback endpoint accepts JSON or multipart NDJSON diagnostic bundle only.                                                                    | Keep ZIP/minidump upload as a later binary artifact endpoint; issue text should reference artifact IDs, not embed binaries.                 |

## Proposed Files And Responsibilities

Use concrete module names. Do not create `helpers`, `utils`, or generic dumping
grounds.

### Native Crash Capture

- `src/main/diagnostics/native-crash-dump-directory.ts`
  - Resolves and creates the Crashpad directory.
  - Uses app data/logs paths, never the install directory.

- `src/main/diagnostics/native-crash-reporter.ts`
  - Owns the early `crashReporter.start()` call.
  - Sets `app.setPath('crashDumps', directory)` before start.
  - Adds static `globalExtra` annotations.
  - Starts local-only unless a future user-consented upload path exists.

- `src/main/diagnostics/native-crash-dump-index.ts`
  - Enumerates recent Crashpad dump files and metadata safe for the bundle
    manifest.
  - Does not parse or redact minidump bytes.

### Bundle Archive

- `src/shared/diagnostic-bundle-export-types.ts`
  - Category names, CLI result shape, manifest schema, skipped/error status.

- `src/main/diagnostics/diagnostic-bundle-category.ts`
  - Category parsing and include/exclude resolution.
  - Defaults to all supported local categories.

- `src/main/diagnostics/diagnostic-output-path.ts`
  - Computes default archive paths under Orca logs/diagnostics.
  - Normalizes user-provided `--output` while preserving platform path rules.

- `src/main/diagnostics/diagnostic-archive-writer.ts`
  - Writes a ZIP or directory archive.
  - Records every file in `manifest.json` with bytes, category, and status.

- `src/main/diagnostics/diagnostic-bundle-export.ts`
  - Orchestrates all collectors.
  - Every collector failure becomes a manifest `error` entry unless the core
    output path itself fails.

### Collectors

- `src/main/diagnostics/app-diagnostic-summary.ts`
  - App version, channel, Electron/Chrome/Node versions, app paths with redacted
    or role-only fields.

- `src/main/diagnostics/runtime-diagnostic-counts.ts`
  - Count-only project/worktree/workspace/terminal/runtime summaries.
  - No workspace names, branch names, prompts, paths, or repository names.

- `src/main/diagnostics/terminal-lifecycle-diagnostic-trace.ts`
  - Reads compact terminal lifecycle breadcrumbs/traces once that renderer
    signal is promoted beyond console warnings.
  - Satisfies the existing reliability-gate follow-up that diagnostics bundle
    artifacts prove lifecycle evidence is present.

- `src/main/diagnostics/system-diagnostic-summary.ts`
  - OS platform/release/version, arch, CPU count/model summary, total/free
    memory, locale where safe.

- `src/main/diagnostics/windows-event-diagnostic-summary.ts`
  - Uses `Get-WinEvent` for bounded Application Error/Application Hang records.
  - Filters to Orca/Electron process names and recent lookback.
  - Non-admin access failures become skipped/error manifest entries.

- `src/main/diagnostics/windows-wsl-diagnostic-summary.ts`
  - Captures WSL availability and distro state from bounded `wsl.exe` probes.
  - No filesystem scans of distributions.

- `src/main/diagnostics/shell-availability-summary.ts`
  - Reports whether expected shells are resolvable, not raw environment data.

- `src/main/diagnostics/macos-report-diagnostic-index.ts`
  - Indexes recent Orca-named `.ips`/`.spin` files from accessible diagnostic
    report directories.
  - Does not include full sysdiagnose by default.

- `src/main/diagnostics/linux-coredump-diagnostic-summary.ts`
  - Best-effort `coredumpctl` metadata for Orca/Electron processes.
  - Missing systemd-coredump or permissions become skipped/error status.

### Windows Memory Refactor

- `src/main/memory/windows-process-working-set.ts`
  - CIM-first Windows process enumeration.
  - Parses PowerShell JSON for `ProcessId`, `ParentProcessId`, and
    `WorkingSetSize`.
  - Handles singleton object JSON, empty arrays, access denied, timeout, and
    malformed output.

- `src/main/memory/collector.ts`
  - Delegates Windows enumeration to the new module.
  - Keeps existing snapshot shape unchanged.

## CLI And RPC Wiring

Add command spec:

- `src/cli/specs/diagnostics.ts`
  - Add `path: ['diagnostics', 'bundle']`.
  - Flags: `--output`, `--lookback`, repeated `--include`, repeated
    `--exclude`, `--open`, `--json`.

Add handler:

- `src/cli/handlers/diagnostics.ts`
  - Parse flags.
  - Call `diagnostics.bundle`.
  - Print archive path and skipped/error category summary.

Add RPC:

- `src/main/runtime/rpc/methods/diagnostics.ts`
  - Add `diagnostics.bundle`.
  - Validate arguments at the boundary.

- `src/main/runtime/rpc/methods/index.ts`
  - Already imports `DIAGNOSTICS_METHODS`; adding to that array should register
    the method.

- `src/main/runtime/runtime-rpc.ts`
  - Add `diagnostics.bundle` to the runtime method allowlist next to
    `diagnostics.memory`.

Packaged launchers:

- `resources/win32/bin/orca.cmd` should not need behavioral changes for the
  command itself. The viable comment is already true: the shim runs the unpacked
  CLI through `Orca.exe` using `ELECTRON_RUN_AS_NODE=1`.
- Add/extend packaged CLI tests so Windows, macOS, and Linux launchers prove
  `diagnostics bundle --help` and argument forwarding are available.

## Default Paths

The main process should compute the default path because it has Electron path
APIs:

```text
<app.getPath('logs')>/diagnostics/orca-diagnostics-<YYYYMMDD-HHMMSS>.zip
```

Expected platform defaults after Electron log path resolution:

- macOS: `~/Library/Logs/Orca/diagnostics/...`
- Windows: inside Orca's per-user app data/logs location
- Linux: inside Orca's per-user app data/logs location

Do not write under `Program Files`, the `.app` bundle, AppImage mount paths, or
other install directories.

## Archive Contract

Every archive should include:

```text
manifest.json
app/orca.json
system/os.json
system/resources.json
diagnostics/observability.ndjson
memory/snapshot.json
crash/orca-crash-reports.json
```

Include when available:

```text
app/runtime-counts.json
crash/minidumps/*.dmp
windows/events.json
windows/wsl.json
windows/shells.json
macos/reports-index.json
macos/shells.json
linux/coredumpctl.json
linux/journal.json
linux/shells.json
```

`manifest.json` should list:

- schema version
- bundle ID
- collected timestamp
- Orca version/channel
- platform/arch
- output category statuses
- file list with category, relative path, byte size, and SHA-256
- skipped categories with reason codes
- errors with sanitized reason codes

## Privacy And Permissions Rules

- Main process collects all bytes. Renderer and CLI callers may request
  categories and output path, but must not supply archive payloads.
- Native minidumps are sensitive. Local explicit export may include them by
  default; upload and issue attachment require a separate explicit consent gate.
- Do not collect raw terminal scrollback by default.
- Do not collect full env vars by default.
- Do not collect repository contents by default.
- Runtime/workspace/project summaries should be count-only unless a future
  explicit "include names/paths" option is added.
- Platform collectors must be bounded by lookback, max event count, max byte
  count, and timeout.
- Permission failures should be visible in the manifest, not fatal.

## Happy Path Tests

- `orca diagnostics bundle --json` returns archive path, bundle ID, included
  categories, skipped categories, and byte size.
- `orca diagnostics bundle --output <tmp.zip> --json` writes a ZIP containing
  `manifest.json`, app summary, system summary, observability NDJSON, and memory
  snapshot.
- Existing `orca diagnostics memory` CLI output and RPC behavior remain
  unchanged.
- CrashReporter initializer sets crash dump path before starting Crashpad.
- Renderer crash test in a controlled Electron harness creates a minidump after
  crashReporter startup.
- Terminal lifecycle anomaly test proves the bundle includes recent compact
  lifecycle breadcrumbs/traces, matching the reliability-gate promotion
  criteria.
- Packaged Windows CLI shim forwards `diagnostics bundle --help` through
  `Orca.exe` with `ELECTRON_RUN_AS_NODE=1`.

## Non-Happy Path Tests

- Output directory unwritable: command fails with a clear error before partial
  archive success is reported.
- Invalid `--include`/`--exclude`: command rejects with known category names.
- No Crashpad dumps: archive succeeds with `native-minidumps` skipped.
- Diagnostics disabled in Privacy settings: observability category is skipped or
  rejected according to the final consent policy; native local export policy must
  be explicit.
- Windows `Get-WinEvent` access denied: archive succeeds with event category
  error in manifest.
- PowerShell missing or CIM malformed: Windows memory collector falls back or
  records a non-fatal collector failure without breaking existing snapshot
  shape.
- Linux without `coredumpctl`: category skipped.
- macOS without DiagnosticReports access: category skipped.
- Archive size cap exceeded: category truncates or skips according to manifest
  policy; command does not silently omit data.

## Validation Gates

Run the narrowest relevant gates for each phase:

```text
pnpm test -- src/main/memory/collector.test.ts
pnpm test -- src/main/runtime/rpc/methods/diagnostics.test.ts
pnpm test -- src/cli/index.test.ts
pnpm test -- src/main/ipc/diagnostics.test.ts
pnpm test -- src/main/ipc/crash-reporting.test.ts
pnpm typecheck
pnpm lint
```

For packaging and launcher confidence:

```text
pnpm test -- src/main/cli/packaged-cli-assets.test.ts
pnpm test -- src/main/cli/windows-launcher-asset.test.ts
pnpm run build:win
```

The Windows build is expensive and platform-specific; it should be required
before merge for this feature, but not necessarily after every small planning
edit.

## Explicit Deferrals

- Server-side symbolication pipeline.
- Binary artifact upload endpoint.
- Provider-neutral auto issue creation with private diagnostic artifacts.
- Full heap snapshots.
- Full macOS sysdiagnose capture.
- ProcDump bundling or auto-download.
- WER registry mutation.

These are real requirements for a complete support system, but they should not
block the first local `orca diagnostics bundle --output` implementation.
