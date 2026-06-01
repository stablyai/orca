# Renderer Memory Profile, 2026-06-01

## Scope

This profile investigated high Orca renderer memory while working in
`/Users/nwparker/orca/workspaces/orca/goal`. The user suspected the browser
might not actually have an open tab, so the investigation checked browser,
renderer, terminal, and Resource Usage attribution paths separately.

## Live Evidence

- Orca runtime was reachable through the packaged CLI fallback. The public
  `/usr/local/bin/orca` shim pointed at a removed development app path, so it
  failed before contacting the runtime.
- `orca tab list --worktree all --json` returned `tabs: []`. There were no live
  Orca browser tabs in the measured session.
- The live packaged app had one renderer process and no separate browser guest
  renderer process. A later `ps` sample showed:
  - main process: 390 MB RSS
  - renderer process: 460 MB RSS, about 40 percent CPU
  - GPU process: 145 MB RSS
  - network service: 59 MB RSS
  - audio service: 48 MB RSS
- `sample` on the renderer showed V8, IPC, and deserialization stacks while the
  renderer was busy. It did not show browser guest activity.
- `vmmap -summary` on the renderer showed about 218 MB physical footprint and a
  373 MB peak, while total resident accounting was about 1.7 GB. Most of that
  larger number was shared Electron/Chromium mappings, especially read-only
  library mappings.
- `orca terminal list --worktree active --json` showed the active Codex terminal
  preview retaining repeated status redraw fragments such as repeated
  `Working` text. The retained terminal tail buffers were bounded, but the
  text normalization path was treating redraw controls as append-only text.

## Findings

1. Browser tabs were not the live-session memory source. The session had no
   browser tabs and no browser guest renderer process.
2. The browser-pane retention fix is still useful: inactive worktree browser
   webviews are now unmounted so Chromium can release guest renderers. Browser
   state remains in Orca, and automation-visible webviews stay mounted so
   agent-browser can keep driving them.
3. Resource Usage was using `app.getAppMetrics().memory.workingSetSize` for
   Orca app buckets. On macOS this can count large shared Electron/Chromium
   mappings and make the renderer look much larger than its private footprint.
4. The active terminal path was producing noisy previews from TUI redraws. This
   explains the high active renderer churn observed during the profile, even
   though the terminal memory buffers were already capped.

## Changes Made

- Browser panes now mount their backing webview only when the pane is active or
  automation-visible. This sleeps inactive worktree browser guest renderers
  without sleeping the main Orca renderer.
- Browser crash breadcrumbs now include webview counts, parked webview counts,
  hidden webviews, and registered browser guest counts.
- The memory collector now prefers the existing host process RSS sweep for
  Electron app bucket memory, falling back to Electron working-set data only
  when a host row is missing.
- Terminal preview retention now applies carriage-return and backspace redraw
  controls before appending text to the retained preview tail.

## Validation

- Browser overlay, webview registry, and crash diagnostics tests passed.
- Browser tab e2e tests passed.
- Memory collector tests passed, including host RSS preference and fallback
  coverage.
- Runtime terminal tests passed for carriage-return and backspace redraw
  normalization, plus the existing bounded partial-tail coverage.

## Remaining Risk

The current packaged Orca app was not running this worktree's patched code
during the live profile. The fixes are covered by unit and e2e tests, but the
next packaged build should be re-profiled under the same active Codex TUI load
to confirm the Resource Usage display and terminal previews match the expected
lower-churn behavior.

## Follow-up: CLI Profiling Blocker

Continuing the profile after this change confirmed the public
`/usr/local/bin/orca` command was still broken because it was a regular
generated launcher file pointing at a removed development build. The CLI
installer previously self-healed stale symlinks, but treated regular files as
conflicts. That meant Settings could not replace an Orca-owned stale launcher,
forcing profiling to use the packaged CLI fallback.

The follow-up fix teaches the installer to recognize only generated Orca Unix
launcher files as stale and replaceable. Arbitrary regular files at the command
path remain conflicts.

## Follow-up: Repeatable Memory Diagnostics

The next profiling blocker was repeatability: collecting a useful memory sample
still required combining Resource Usage IPC, terminal lists, browser tab state,
and host process output by hand. This branch adds `orca diagnostics memory`,
which exposes the existing main-process memory collector through runtime RPC.

The command returns the same `MemorySnapshot` shape used by Resource Usage when
run with `--json`, including host memory, Orca app process buckets, worktree
terminal memory, per-session process roots, and history samples. Text output
prints a compact point-in-time summary and the top worktrees by retained
terminal memory.

## Follow-up: Agent-Browser Paintability Guard

The browser parking fix depends on automation-visible panes staying paintable
without activating the user's worktree. The renderer bridge previously waited
for two animation frames before creating the automation visibility lease, so the
paint wait happened while the parked webview was still hidden. Non-screenshot
agent-browser commands could therefore start immediately after the lease was
created, before React had made the hidden pane paintable.

The follow-up changes the order: create the automation visibility lease first,
then wait for paint while the pane is actually visible to automation. A
renderer-side timeout releases the lease if paint never arrives, so a hung RAF
does not pin an inactive browser pane indefinitely.

## Follow-up: Browser Registration Readiness

One remaining automation race was the wake path for parked or restored browser
tabs. Runtime browser commands asked the renderer to mount a hidden browser
pane, then waited a fixed 500 ms before reading the agent-browser tab registry.
On slow webview startup, that could still race `registerGuest` and make
agent-browser report no tab even though the tab was in the process of mounting.

The follow-up extends the existing tab-registration wait from page-specific
creation to worktree/global wake flows. Runtime commands now wait for the
renderer's actual `browser:registerGuest` IPC before routing automation, with
the same timeout fallback used by tab creation.
