# Wrapped Terminal File-Link Fragments

## Problem

A file path hard-wrapped between terminal rows is not clickable when the continuation row also contains sibling content. In the reported three-link line, the middle path ends the first row and continues at the start of the second, while the first and third paths remain clickable.

The provider builds hard-wrap candidates in `wrapped-terminal-link-ranges.ts:172-224`, and both hover and direct modifier-click consume them through `terminal-link-handlers.ts:106-135` and `terminal-file-link-hit-testing.ts:100-109`.

## Root cause

`buildHardWrappedPathLogicalLineCandidates` trims and joins whole physical rows. A continuation row is accepted only when the entire trimmed row is a path fragment (`wrapped-terminal-link-ranges.ts:195-203`). A row such as `transparent-...png · validation-screenshots/03-after-light-theme.png` therefore stops reconstruction. Orca probes the two incomplete middle fragments separately, rejects both as nonexistent, and retains only the complete first and third paths.

## Non-goals

- Changing file-path parsing, filesystem existence semantics, tooltip copy, or open routing.
- Joining arbitrary prose, spaced paths, or multiple sibling links into one path.
- Relying on xterm soft-wrap metadata for output that was hard-wrapped by an agent or TUI.
- Adding a new IPC method, bypassing the existing existence cache, or changing local/SSH/runtime routing.

## Design

1. Add a focused regression using the exact three-link/two-row shape. Make the existence stub return true only for the three complete paths, then assert that provider calls for either physical row return the same middle link and exact multi-row range. Assert that no candidate/link spans either `·` separator.
2. Reuse the existing conservative hard-wrap fragment alphabet. From a possible first row, slice its maximal fragment suffix; append zero or more continuation rows only while their whole trimmed text is a fragment; then slice the maximal fragment prefix from the first mixed-content row and stop. The only suffixes accepted without a path-name character are an exact POSIX root (`/`), one backslash for the first half of a UNC root, a bare ASCII drive prefix such as `C:`, and the complete relative prefixes `./`, `../`, and `~/`. A boundary candidate is emitted only when it covers the requested row, has at least two non-empty row fragments, and the fully joined text passes the existing path-start predicate. It may end at the first proper prefix slice of a mixed row or at the last available whole-fragment row; the latter is limited to whitelisted incomplete starts and is skipped when whole-row reconstruction already emitted the same text. Existing whole-row candidates remain responsible for ordinary/deep hard wraps, including a mixed starting row followed only by whole-fragment rows.
3. Slice `columns` with each fragment so ranges retain the original xterm cells. Build the async-staleness fingerprint from each source row's full translated text and metadata as well as the selected slice; changing a sibling token must invalidate an in-flight result even if the reconstructed path is unchanged.
4. Generate at most one boundary candidate per scanned start row—never every suffix/prefix combination. Preserve the existing bounds of 20 possible start rows and 20 rows per candidate, logical-line deduplication, and longest-non-overlapping-link selection. The existing builder can emit up to 210 whole-row candidates in its all-fragment worst case; this change may add at most 20 boundary candidates, not another quadratic set.
5. Keep existence validation in the provider's current local/SSH/runtime path and cache. The valid reconstructed path necessarily adds its desired existence lookup compared with the broken behavior; do not add probes for arbitrary suffix/prefix combinations or change existing overlap/cache behavior in this focused fix.
6. Verify direct modifier-click fallback from both halves. This path shares the candidate builder but remains synchronous and uses its existing cache/known-root preference before `openDetectedFilePath` performs normal routing checks.

## Data flow

- xterm buffer row under hover/click
- bounded hard-wrap start/candidate windows and conservative endpoint slicing
- whole-row candidates plus at most one boundary candidate per start row
- existing terminal file-link parser
- existing local/SSH/runtime path resolution and existence cache
- mapped multi-row xterm range
- hover tooltip or modifier-click open

## Edge cases

- A row boundary immediately after POSIX `/`, drive prefix `C:`, the first `\` of a UNC path, or complete `./`, `../`, and `~/` prefixes must reconstruct the complete path. Other punctuation-only suffixes and bare prose tokens remain ineligible, and the joined text must independently satisfy the full path-start predicate.
- A continuation prefix may end before a separator (`·`), prose, or a sibling path; none of that suffix may enter the reconstructed candidate.
- A starting suffix may begin after prose or a sibling path; its original xterm column must be retained.
- Rows containing only one path fragment must keep the existing deep (up to 20 rows) reconstruction behavior.
- Soft-wrapped rows, Unicode/multi-code-unit column mappings, known worktree roots, and spaced paths must remain unchanged. In particular, this change does not broaden fragment extraction to whitespace-containing paths.
- Full-row source fingerprints must reject stale async results when text inside or outside the selected fragment changes.
- Provider calls for remote paths must still use the owning pane's runtime environment or SSH connection and the connection-scoped existence-cache key; fragment extraction itself must not assume a local filesystem.
- Incomplete fragment combinations remain filtered by the existing filesystem existence check.

## Test plan

- Candidate/range unit: cover the exact suffix/prefix slices, original xterm columns, full-row fingerprint changes, at most one added boundary candidate per start row, and no candidate spanning a sibling separator.
- Provider integration: add the exact reported three-link regression to `terminal-link-handlers.test.ts`; across provider calls for both physical rows, assert all three complete links, the same middle range from each call, no incomplete or giant merged link, and that the complete middle path reaches the normal existence check.
- Direct click: exercise hit-testing on the first and second physical halves of the middle path and assert both route the same complete path.
- Compatibility: cover a backslash/drive-letter wrapped path and a remote-runtime or SSH existence call, proving the reconstructed path keeps the owning connection/environment.
- Regression: run `wrapped-terminal-link-ranges.test.ts`, `terminal-link-handlers.test.ts`, and terminal-link parser tests.
- Static: run formatter/check, web typecheck, lint, max-lines ratchet, and relevant repository checks.
- Electron: render the exact text at the reproduced 133-column terminal width; verify pointer/tooltip and modifier-click from both middle fragments, then smoke-test the first and third links.

## UI quality bar

No visual styling changes. The exact same terminal text and layout must render without overlap, clipping, or altered wrapping. The only visible behavior change is that both physical halves of the middle path show the same pointer affordance and tooltip and activate the same file, consistent with the first and third links and `docs/STYLEGUIDE.md` interaction guidance.

## Review screenshots

1. Before, on the base revision: full Electron window hovering the broken middle path at the reproduced width (no tooltip/link affordance).
2. After: full Electron window hovering the first physical half of the middle path, with tooltip visible.
3. After: full Electron window hovering the continuation half, with the same tooltip/path visible.
4. After adjacent-feature smoke: full Electron window hovering the first or third complete sibling link.

## Rollout

1. Add the failing exact-shape regression and range/click assertions.
2. Implement boundary-fragment candidate extraction and cell mapping.
3. Run focused tests and static checks.
4. Validate the exact scenario in Electron and capture screenshots.
5. Open an unmerged PR.

## Lightweight Eng Review

- Scope: limited to hard-wrapped path candidate reconstruction; parser, routing, cache, and UI styling stay unchanged.
- Architecture/data flow: the shared candidate builder remains the single boundary for hover and click behavior, so local, daemon, SSH, and remote runtime flows receive identical ranges before their existing existence checks.
- Failure modes covered:
  - sibling links accidentally merged into one spaced path
  - only one physical half hit-tests
  - incorrect xterm columns after slicing
  - Windows separators rejected
  - deep single-fragment rows regress
  - extra remote/local existence probes on hover
- Test coverage required:
  - exact three-link provider regression from both hovered rows
  - exact range boundary assertions
  - direct click from both halves
  - existing deep-wrap, Unicode, stale-result, parser, SSH/runtime tests
- Performance/blast radius: preserve the current 20-start-row/20-rows-per-candidate bounds (up to 210 existing whole-row candidates). Boundary extraction is linear per examined row and adds at most 20 candidates, only where a mixed continuation stops whole-row reconstruction. Resolving the previously missing complete path adds the intended cached existence check; the change adds no IPC method and does not alter local/remote routing or cache keys.
- UI quality bar: unchanged rendering and style; consistent pointer, tooltip, and activation across both middle fragments, checked in the real Electron terminal against the style guide.
- Required review screenshots:
  1. exact three-link full-window baseline
  2. middle first-half hover/tooltip
  3. middle continuation-half hover/tooltip
  4. first/third sibling hover smoke
- Residual risks: local macOS is the available live Electron environment; Windows separator and SSH/runtime behavior require automated coverage and shared-code review.

## Terminal Reliability Proof

- Reliability class: `terminal-link.path-boundary-reconstruction`; the broader manifest entry `xterm-addon.boundary-containment` is related but does not register file-link correctness, so this remains an explicit accepted manifest gap rather than changing that gate's scope in a bug fix.
- Product change type: renderer runtime hardening with deterministic regression coverage.
- Invariant: one logical hard-wrapped file path maps to the same original xterm cells and owning local/SSH/runtime context from either physical row, without absorbing sibling text.
- Failure source: the reproduced three-link line where only the first and third links were clickable.
- Oracle: both provider row calls return the same complete middle path/range; direct hit-testing on either half opens that path; root-, drive-, and UNC-boundary candidates retain their exact xterm ranges; no emitted boundary candidate contains `·`.
- Provider/platform matrix: local and SSH provider behavior covered; Windows separators/cell mapping covered; daemon and remote-runtime use the same builder and routing but are not live-tested; Linux, Windows, WSL, mobile/relay are accepted live-validation gaps.
- Performance budget: the scan stays capped at 20 starts and 20 rows per candidate, emits at most one boundary candidate per start, and rejects non-path starts before reading possible continuation rows. No polling, timers, listeners, subprocesses, or new IPC methods are added; only the newly valid path reaches the existing cached existence probe.
- Diagnostics: the full source-row fingerprint rejects stale async results; deterministic range/provider tests are the regression breadcrumb. No new product telemetry or raw terminal logging is warranted.
- Gate status: no manifest entry added or promoted. Revisit only if this parser grows beyond bounded local row reconstruction or the regression recurs outside the covered provider/platform matrix.
- Rollback/demotion rule: revert boundary-fragment reconstruction if Electron shows sibling-path merging, incorrect hit regions, or material hover latency; keep the exact red regression as the behavioral oracle.
