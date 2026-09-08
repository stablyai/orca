# Scrollback retention and memory investigation

2026-09-07. Baseline: `d0506bf5de0da490025d94c6507378be75194a60`.

## Outcome

The setting was not simply too small: several restore paths silently replaced deep
history with a smaller buffer. The retention fix is
[PR #19368](https://github.com/stablyai/orca/pull/19368). The stacked [memory/settings PR #19383](https://github.com/stablyai/orca/pull/19383)
adds an opt-in 100,000-row preset, fixes two independent 50k request caps and
the runtime mirror preference, bounds concurrent reconstruction grids, and compacts
repeated trailing cells in browser xterm. The default stays 5,000 rows and the minimum
stays 1,000; existing legacy settings retain their previous migration values.

The memory candidate reduces short-log cell storage by approximately **87% at 200
columns**. Dense rows save nothing and their resize benchmark regresses by **25%**.
Keep the memory change in draft for performance review; do not raise the default
based on short-log savings alone. These are measured implementation results, not
claims of an 87% reduction in total Orca memory.

## User reports and root causes

- [#11560](https://github.com/stablyai/orca/issues/11560): selecting 50k still yields
  roughly 5k, including remote usage. Durable replay used the default instead of the
  supported ceiling. A separate runtime mirror also retained only 5k and could win
  snapshot selection over the deeper provider.
- [#12864](https://github.com/stablyai/orca/issues/12864): daemon depth mismatch.
  Current daemon live retention is intentionally 1k; the solution reconstructs from
  disk instead of permanently allocating another full-depth grid for every session.
- [#17114](https://github.com/stablyai/orca/issues/17114): log rotation replaces
  durable history with the live window. Rotation now requests a checkpoint after a
  successful append crosses half the unchanged 5MiB log cap. A refused batch from
  an already-full log is included in immediate compaction only with proven sequence
  continuity. Actual overflow, gaps, and old-daemon responses retain the live fallback.
- [#14593](https://github.com/stablyai/orca/issues/14593): incomplete snapshots erase
  history. The new deep-request path prefers the durable provider, then a renderer
  when that provider cannot supply a snapshot. This does not recover already-lost
  output or remove every existing lossy fallback.
- [#18489](https://github.com/stablyai/orca/issues/18489), closed: synchronous
  serialization stalls. Replay yields, but final serialization remains synchronous.
  Admission bounds scratch-grid concurrency; it does not make serialization free.
- [#10879](https://github.com/stablyai/orca/issues/10879): quadratic decoration
  eviction is a separate scaling risk. Basic deep search and selection are checked;
  this work does not claim to solve decoration-heavy performance.
- [#19048](https://github.com/stablyai/orca/issues/19048): durable bookmarks are a
  useful follow-up, outside this storage/settings change.

The 100k rendered regression uncovered both the desktop snapshot IPC's independent
50k clamp and the same clamp in paired-stream request normalization. Both now reuse
the shared policy. The test emits 75k numbered rows, changes workspace, returns,
scrolls to row zero, searches for it, and verifies the selected text. Before the
runtime fix, diagnostic output began around row 69,941; with only that fix it began
around row 24,707. With the IPC fix, row zero survives.

## Source research: repositories actually cloned

Clones were inspected under `tmp/scrollback-research/` in this worktree.

| Repository / revision | Relevant source and finding |
| --- | --- |
| [xterm.js, current inspected revision](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/buffer/BufferLine.ts) | Three Uint32 words per column: 12 bytes per cell before sparse attributes and object overhead. `cleanupMemory` recovers excess backing storage after shrinking; it does not encode trailing repeated cells. |
| [xterm.js, exact pinned revision](https://github.com/xtermjs/xterm.js/blob/d3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789/src/common/buffer/BufferLine.ts) | Basis for the source patch and differential oracle. Browser beta.303 and headless beta.302 derive from this same commit. The browser patch is regenerated through Orca's existing reproducible patch pipeline. |
| [Superset constants](https://github.com/superset-sh/superset/blob/672885f204f81763d2fb0183e707504a7ddd8756/apps/desktop/src/shared/constants.ts) and [runtime registry](https://github.com/superset-sh/superset/blob/672885f204f81763d2fb0183e707504a7ddd8756/apps/desktop/src/renderer/lib/terminal/terminal-runtime-registry.ts) | 5k default; runtime transfer serializes 1k. Parking/disposal limits retained terminals. No compact cell representation was found in the inspected terminal paths. |
| [VS Code terminal configuration](https://github.com/microsoft/vscode/blob/840bed2d24d0ba85c2919d816953fa66955374ad/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts) and [xterm integration](https://github.com/microsoft/vscode/blob/840bed2d24d0ba85c2919d816953fa66955374ad/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts) | 1k default and an explicit memory-cost warning. Updates xterm's scrollback option and uses the serialize addon. Persistent-process revival documents shutdown/remote latency limits. No compact cell representation was found in the inspected integration. |

These consumers offer useful lifecycle/budget patterns, but neither inspected path
provides a drop-in compact grid. A lower serialized restore depth also recreates the
very retention mismatch Orca users report.

## Memory design and alternatives

A browser `BufferLine` keeps its unique prefix and one repeated final cell triple.
It packs only when the representation saves at least half the original cell bytes;
dense rows retain normal arrays. Primitive reads, cell loading, trimming, and string
translation read packed data directly. Mutations expand the array; compatible
empty-tail resizing changes the logical width without allocating a full row.
Combined characters, extended styles and links retain their sparse maps.

Compaction runs in a microtask after synchronous cell copies finish. Compacting
inside an array setter can invalidate raw references held by two-line copy routines.
The recent queue uses WeakRefs and retains its last 256 entries after each drain;
it does not root disposed terminals. It may temporarily grow during a synchronous
parse/reflow, and repeated references mean it is not a count of distinct hot rows.
This is a workload-sensitive representation, not a hard per-terminal memory quota.

A first lazy-inflation-only prototype saved storage but made resize approximately
19 times slower. It was rejected. Direct packed reads and the empty-tail resize
path avoid that failure. Full compression of serialized history would save more
bytes, but loses efficient random cell access and requires a different renderer,
search, selection and reflow architecture. Increasing every daemon's live grid
would multiply memory across sessions and was also rejected.

The headless package remains unmodified. A single shared `PrioritySemaphore(1)` now
admits both disk replay and durable-checkpoint scratch emulators within a process.
This bounds concurrent full grids, including simultaneous pane restores and
checkpoints. It is not an across-process limit, and pending serialized data still
consumes memory. Existing timeouts and live fallbacks remain relevant under load.

## Reproducible measurements

macOS, Node 26.6.0; three sequential fresh-process samples per case, with explicit
GC and event-loop turns. Values below are medians. The unchanged same-commit headless
package is the baseline; the installed browser package includes the final source
patch. No other agent-launched benchmark/build/test ran concurrently. This isolates
cell storage reasonably well but does not measure Electron GPU, DOM, IPC, total RSS,
real-world typing latency, or Linux/Windows performance.

Run from the worktree (repeat for `headless`, both fixtures and requested depths):

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc tests/tools/benchmarks/terminal-scrollback-storage-bench.mjs 50000 200 short-log desktop
```

Raw samples: [terminal-scrollback-benchmark.jsonl](terminal-scrollback-benchmark.jsonl).
MB means decimal MB. All 18 original and post-resize serialized hashes match their
paired baseline; resize narrows from 200 to 80 columns and returns to 200.

| Rows / fixture | Cell MB baseline → patched | JS heap MB baseline → patched | Write ms baseline → patched | Serialize ms baseline → patched | Resize ms baseline → patched |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50k short logs | 120.06 → 15.94 | 19.60 → 20.08 | 288 → 317 | 207 → 221 | 31.7 → 15.1 |
| 100k short logs | 240.06 → 31.74 | 40.02 → 40.90 | 574 → 633 | 398 → 428 | 65.0 → 27.9 |
| 50k dense styled/Unicode | 120.06 → 120.06 | 35.60 → 36.07 | 391 → 433 | 393 → 420 | 429 → 538 |

Short-log writes cost about 10% more and serialization 6–8% more. Dense writes cost
11% more and resize 25% more. The benchmark excludes browser painting and does not
prove that interactive resize latency has the same relative cost. A 100k sparse
grid can use fewer cell bytes than the old 50k grid, but a 100k dense grid cannot.

## Validation and boundaries

- 1,035 upstream common tests passed on the final patched source. Reproducible bundle
  regeneration `--check` passed after installing the regenerated patch.
- Installed-package differential tests compare full cell attributes, wrap flags and
  serialization through Unicode, combining characters, links, style changes, margins,
  alternate screens, erasure, reflow and eviction. Three seeded mutation sequences
  exercise 180 operations each.
- The final 14-suite run passed 127 tests and exposed one stale 50k IPC expectation.
  After correcting it and adding deeper renderer fallback coverage, all 57 tests in
  the four affected runtime/IPC/history suites passed. Other passing suites included
  policy, settings, 100k disk reconstruction, memory admission, parked SSH restoration
  and current/released terminal wire pairings in both directions.
- Node/web typechecks and changed-code quality passed. The E2E build passed. All four
  hidden Electron checks passed: 100k settings/75k-row restore, two wrapped-table
  cases, and real emoji tables. A subsequent 100k run also verified search/selection
  of the first retained row. Settings were exercised in light/dark mode at 760px; the existing settings layout
  requires horizontal scrolling at that width.
- Folder history is covered by real-file tests using an ordinary temporary directory,
  with no Git repository. The rendered workspace-switch test uses git worktrees;
  it is not a folder-workspace UI end-to-end claim.
- Local and paired-runtime daemon-backed terminals share the durable implementation.
  No fields/opcodes were added. Old hosts can still clamp to their old limits; this
  client change cannot upgrade a running old host. Paired snapshots retain their
  existing 2MiB byte budget and explicitly report truncation; requesting 100k does
  not promise 100k transferred rows. Mobile limits are unchanged.
- Direct SSH uses relay/renderer retention, not the local disk reconstruction path.
  Renderer fallback and parked-SSH tests pass; no live SSH host was exercised.
  Disconnect replay remains bounded and missing contact never establishes process
  exit. No process-liveness behavior was changed.
- No native Linux/Windows or visible-focus tests ran on this macOS desktop. All apps
  and tests used `ORCA_BACKGROUND_LAUNCH=1`; rendered checks used hidden Playwright CDP.

## Recommendation and next experiments

Review the retention correctness fix independently. Keep 100k opt-in and the compact
storage patch in draft until the dense reflow regression has an accepted budget or
an optimization. Before changing the default, benchmark real agent transcripts at
80/200/400 columns, many simultaneous panes, repeated resize, and search with many
match decorations across all desktop platforms. Investigate off-thread snapshot
serialization and byte-budget-aware deep remote replay next. An upstream xterm
proposal should include the source patch, mutation oracle, allocation measurements
and the dense-workload regression rather than reporting only favorable compression.


## Regression hardening follow-up

A second audit found and reproduced two bugs in the new deep-history preference:

- An empty parked renderer could replace a populated runtime mirror when the
  provider had no snapshot. Empty provisional renderer state now falls through to
  the mirror.
- A stalled provider could indefinitely prevent hidden recovery from reaching its
  renderer fallback. The existing authoritative-snapshot deadline now bounds this
  acquisition. Repeated requests share the outstanding provider acquisition rather
  than starting duplicate provider work. The timeout does not mark a process exited.

Both added tests failed before the fix (empty content and test timeout) and pass
with it. This preserves the existing source-sequence and lifecycle checks.

Additional validation on macOS:

- 1,874 tests passed, 12 skipped, across 177 daemon/restore/remote test files.
- 350 further tests passed across 43 SSH-provider, reconnect, relay, actual SFTP-wire,
  compact-buffer and admission suites. The compaction oracle now includes nine seeds
  and history-depth reduction, clear/reset and subsequent writes. A failing scratch
  replay also proves that another session can acquire admission and restore.
- Hidden Electron paired-web validation passed with six terminal workspaces:
  parking, authoritative restoration, hidden-output suppression and retained-memory
  bounds. The existing test can now run in the hidden project when
  `ORCA_E2E_WEB_CLIENT=1`; it explicitly skips without that web-client build.
- The actual localhost SSH Electron test passed terminal I/O and agent-hook status
  over a throwaway loopback-only OpenSSH server with isolated test keys. SFTP and
  relay deployment were exercised. The listener was stopped after the run. This is
  a real SSH transport check, not a claim of testing a high-latency Linux SSH host.
- The hidden 100k/75k-row restoration and search test passed again after the runtime
  fixes. No test activated a desktop window.
- PR CI identified two stale test expectations for the old 50k policy ceiling;
  their overflow cases now exercise values above 100k. The production policy did
  not need another cap change.

A speculative direct-array copy-path optimization was benchmarked and rejected
because its source candidate resized slower. The published xterm patch and memory
measurements remain unchanged; the dense-resize regression is still a draft review
limit, not a resolved performance claim. Earlier statements about no live SSH
validation are superseded by the loopback SSH result above.
