# Issue Draft: Cross-Platform Diagnostic Bundle And Native Crash Dumps

Status: local diagnostics export implemented in this branch. Keep this draft as
the support-facing summary and as the follow-up issue seed for binary upload,
symbolication, and full platform smoke coverage.

## Summary

Add an Orca diagnostics export that support and users can create from the
packaged CLI:

```text
orca diagnostics bundle --output <filename-or-subpath>
```

The command creates a reviewable ZIP with native crash minidumps when
available, redacted Orca observability spans, crash report context, memory
snapshot, OS/resource summaries, shell/WSL availability, platform-specific
failure evidence, and count-only workspace/project/terminal summaries.

This should build on the current diagnostics and crash-reporting code instead
of creating a parallel support lane.

## Problem

Before this branch, Orca had useful pieces but no single support artifact:

- Settings can create/upload a redacted NDJSON diagnostics bundle.
- Crash reports can attach that NDJSON bundle.
- `orca diagnostics memory` can collect a memory snapshot.
- Process-gone crash reports record app/platform/Electron/Chrome metadata.
- Windows memory collection still shelled out to deprecated `wmic`.
- There was no Electron `crashReporter`/Crashpad native minidump setup.
- There was no local `orca diagnostics bundle --output` archive command.

When users hit native crashes, renderer crashes, GPU failures, WSL/shell
problems, or platform-specific launch issues, support has to reconstruct state
from scattered reports.

## Implemented Solution

The branch implements a two-layer diagnostics system:

1. Native crash capture
   - Start Electron `crashReporter` early with `uploadToServer: false`.
   - Set a deterministic Crashpad directory under Orca's per-user
     logs/diagnostics path.
   - Add static crash annotations: Orca version, channel, platform, arch, OS
     release/version, Electron, Chrome, schema version.

2. Diagnostic bundle export
   - Add `orca diagnostics bundle`.
   - Write a ZIP under an explicit diagnostics-relative `--output` subpath or default
     `<app.getPath('logs')>/diagnostics/orca-diagnostics-<timestamp>.zip`.
   - Include low-risk categories by default.
   - Include local minidumps for explicit local exports when available.
   - Keep upload/issue attachment behind separate explicit consent because
     minidumps may contain process memory.

## Proposed Archive Contract

Required files:

```text
manifest.json
app/orca.json
system/os.json
system/resources.json
diagnostics/observability.ndjson
memory/snapshot.json
crash/orca-crash-reports.json
```

Conditional files:

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

`manifest.json` should include bundle ID, schema version, timestamp,
version/channel/platform, category statuses, file hashes, byte sizes, skipped
reasons, and sanitized collector errors.

## Acceptance Criteria Covered In This Branch

- `orca diagnostics bundle --json` returns bundle ID, output path, byte size,
  included categories, skipped categories, and sanitized errors.
- `orca diagnostics bundle --output <tmp.zip> --json` writes a ZIP under
  Orca logs/diagnostics containing
  the required files.
- Default output path is under Orca's per-user logs/diagnostics directory, not
  the install directory.
- Existing `orca diagnostics memory` behavior remains unchanged.
- Electron Crashpad is initialized before renderer creation and writes dumps to
  the configured directory.
- Native minidumps are included in explicit local exports when present.
- Upload or issue attachment of minidumps requires separate explicit consent.
- Windows process memory enumeration is CIM-first and no longer depends on
  `wmic` as the primary path.
- Windows event-log access failures, missing `coredumpctl`, missing macOS
  reports, and missing minidumps are recorded as skipped/error categories
  without failing the whole bundle.
- Runtime summaries are count-only by default and do not include workspace
  names, paths, prompts, branch names, terminal scrollback, repository contents,
  or raw environment variables.
- The diagnostics bundle includes compact terminal lifecycle breadcrumbs,
  satisfying the reliability-gate artifact gap for the covered unit slice.
- Packaged Windows/macOS/Linux CLI launchers forward the new command correctly.

## Remaining Follow-Ups

- Electron smoke test that a controlled renderer crash creates a minidump in a
  packaged-like harness.
- Binary artifact upload endpoint and private support artifact retention.
- Server-side symbolication pipeline.
- Provider-neutral issue creation that links artifact IDs rather than embedding
  raw dump contents.

## Non-Goals For First Implementation

- Server-side symbolication pipeline.
- Binary artifact upload endpoint.
- Provider-neutral automatic issue creation with private artifact links.
- Full V8 heap snapshots by default.
- Full macOS sysdiagnose capture by default.
- ProcDump bundling or auto-download.
- WER registry mutation.

## Suggested Test Coverage

- CLI spec/handler tests for `diagnostics bundle`.
- Runtime RPC test for `diagnostics.bundle`.
- Bundle writer tests for manifest, category statuses, file hashes, and skipped
  categories.
- Redaction tests rejecting raw paths, prompts, branches, env vars, and terminal
  output in default summaries.
- Windows CIM parser tests for array JSON, singleton JSON, empty output,
  malformed output, timeout, and access denied.
- CrashReporter initializer tests for call order: create directory, set
  `crashDumps`, then start reporter.
- Electron smoke test that a controlled renderer crash creates a minidump.
- Packaged CLI asset tests for Windows/macOS/Linux launcher forwarding.

## Reference Docs

- `docs/reference/native-diagnostic-dumps-research.md`
- `docs/reference/native-diagnostic-dumps-implementation-plan.md`
