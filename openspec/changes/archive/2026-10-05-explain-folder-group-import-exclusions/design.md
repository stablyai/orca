# Design

## Context

See `proposal.md` for motivation and `specs/folder-group-import-explanations/spec.md` for the behavior contract. Design is required because this change spans scanner policy reporting, IPC/RPC results, and multiple Add Project surfaces, with remote-version and payload-size constraints.

Observed implementation:

- `nested-repo-discovery.ts` returns immediately for `selectedPathKind: git_repo`. For non-Git folders it performs bounded breadth-first traversal, checks existing ignore policy before Git markers, does not descend into discovered repositories, and currently swallows directory-read errors.
- `nested-repo-scan-rules.ts` combines effective `.gitignore` matching and built-in skips into a boolean. Parsed rules retain scope and negation, but not their source file or original rule text.
- `NestedRepoScanResult` carries repositories, classification, and limit flags, but no exclusion evidence. Depth-boundary non-traversal does not set `truncated`; that flag currently describes a repository-count stop.
- Local IPC and SSH filesystem adapters reuse the scanner in `src/main/ipc/repos/nested-repo-scan-ipc.ts`. Paired runtimes call the same scanner through `runtime-nested-repo-import.ts` and `projectGroup.scanNested`.
- Local and server-path Add Project flows only enter nested review for non-Git results containing repositories. Git-root and zero-result cases proceed into existing open-project/open-folder paths.
- `AddRepoNestedImportStep.tsx` shows found counts; `NestedRepoScanLimitNotice.tsx` explains partial results on selected flags. `normalizeNestedRepoScanResult` already preserves additive fields through its spread.

## Goals / Non-Goals

**Goals:**
- Attribute observed decisions where they occur, without a second scanner or renderer-side filesystem inference.
- Make explanations persistent and readable in existing Add Project result surfaces, including git-root and zero-result cases.
- Preserve repository paths/order and execution-host ownership while bounding diagnostic retention.

**Non-Goals:**
- No scan-policy, traversal-depth, request-option, import-mode, or folder-workspace attachment changes.
- No rescan button, ignored-folder inclusion toggle, filesystem editing, or repair actions.
- No exhaustive inventory of repositories inside excluded directories and no logging of full diagnostic paths/rules to telemetry.

## Decisions

### 1. Report policy reasons from the existing matcher

Extend the existing ignore-policy evaluation to return an optional reason while keeping its current boolean caller contract usable. Do not rerun glob matching in a separate reporting pass. Preserve rule provenance during parsing: source `.gitignore` path, original rule text, and line number. Record the last effective positive rule only if the final decision excludes the directory; negated rules and later overrides must retain current semantics. If a built-in policy still excludes a directory after a negation, report that policy rather than attributing the exclusion to the negated rule.

Observed reason categories are `.gitignore`, built-in directory, hidden directory, and symlink. The scanner separately records directory-read failure and depth-boundary non-traversal. These are not all policy exclusions and must be labeled separately. Git metadata directories remain skipped; no additional Git capability or command is needed.

Alternative rejected: use a second pass to inspect ignored directories. That would change scan cost and falsely suggest pruned contents were checked.

### 2. Add optional bounded diagnostic response metadata

Add optional `diagnostics` to `NestedRepoScanResult`. It contains counts of observed decisions, up to 100 retained detail records, and the number of omitted detail records. Detail records identify path and reason; ignore records additionally identify source file, rule text, and line. Read failures carry a checked error code when available, never a guessed permission diagnosis. Unknown wire reasons degrade to a neutral explanation without rejecting repository results.

Counts apply to each directory decision actually encountered, not estimated descendants or repository counts. A depth record means a non-repository directory was encountered at the existing traversal boundary and not descended into. Keep `truncated`, `timedOut`, and `stopped` unchanged; do not reinterpret `truncated` as a depth-limit flag. If multiple existing flags apply, present each supported fact.

Bound retained paths and rule excerpts as well as record count; mark shortened text explicitly. Count omitted records only from decisions already visited. The UI must not claim diagnostics cover paths beyond the scan frontier. Existing Git-root classification is sufficient evidence for its explanation even if optional diagnostics are absent.

Alternative rejected: make diagnostics required or introduce a new RPC method. Existing optional JSON response fields work across independently updated clients and hosts; request parameters and method names stay unchanged.

### 3. Carry snapshots through existing host-owned paths

Return diagnostics on final results and existing progress snapshots. Capture immutable bounded detail snapshots so later scan updates cannot mutate earlier published results. No new stream opcode, host cache, global store, or local fallback scan is required.

Update the local/SSH filesystem boundary only where needed to preserve error provenance. Paired runtimes continue producing their own results. Renderer normalization must preserve absent diagnostics as unknown, not replace them with zero exclusions. Older hosts retain existing classification and limit explanations; detailed exclusion evidence is unavailable.

Keep UI cancellation/generation guards and captured host selection intact. Reset explanation state with the existing Add Project flow when path, host, or attempt changes so late results cannot attach to a different selection.

### 4. Reuse existing review surfaces, including missing-result branches

Add a small domain-specific scan-explanation presentation component shared by repository review and selected-path result states; reuse existing inline text, disclosure, and dialog primitives. This is one presentation concern, not a new wizard or a second import subsystem.

Add a secondary `Import folder as group` entry to the existing Add Project actions. Track that intent as dialog-local state, reset it with path/host/attempt changes, and reuse the existing local/SSH/paired-runtime picker and scanner. Do not add backend request options or CLI commands. Ordinary `Browse folder` selecting a Git repository continues to open it without an extra step. Only for explicit group-import intent and a selected Git repository, keep the Add Project surface open long enough to show the classification and the existing open-project continuation. Suggested copy: "This path is a Git repository. Nested repository scanning was skipped, so group import is not available for this selection." This is an informational result step, not a new scan mode. Continue through the existing project-open path when the user confirms; do not lose the explanation by auto-closing first.

For non-Git results with repositories, show diagnostics next to the found count in `AddRepoNestedImportStep`. For zero-result scans with reportable diagnostics, retain the existing folder-open continuation but show zero results and reasons before opening the folder. Clean zero-result scans without additional evidence can retain their current flow. Preserve existing import selection and all host-specific routing.

Show the summary inline; put paths and matching-rule evidence behind a keyboard-operable disclosure. Keep actual limits and unreadable paths distinct from deliberate exclusions. Example copy is "14 folders excluded by .gitignore", not "14 repositories missing". Counts in examples are illustrative, not hard-coded. Show "additional details omitted" when bounded retention drops records.

Use existing design-system tokens and localized labels. Escape/render paths and patterns as literal text. Keep long-path details scrollable without obscuring primary controls. Critical explanation text must not exist only in a tooltip or temporary toast.

Alternative rejected: explain via console messages or a toast after opening. Neither leaves a readable explanation where the user decides how to add the project.

## Risks / Trade-offs

- Matcher provenance can drift from actual exclusion behavior -> derive the reason from the same evaluation and test inherited rules, anchoring, negation, and built-in precedence against unchanged candidate lists.
- Diagnostics may imply an exhaustive search -> label observed folders, depth boundaries, shortened evidence, and omitted details explicitly; never inspect pruned subtrees for counts.
- Broad scans can grow response size or copy costs -> retain at most 100 records, bound strings, reuse existing progress cadence, and preserve queue/budget tests.
- Git-root explanations could interrupt normal repository import -> gate the continuation on explicit group-import intent, reset that intent between attempts, and test ordinary browsing remains uninterrupted.
- Mixed-version hosts lack evidence -> show supported classification/limit facts only, with no fabricated zero-exclusion result or rejection of valid repository data.
- SSH failures and long paths differ from local ones -> test the shared scanner with remote filesystem fixtures and Windows/POSIX paths; do not infer remote state locally.
- Earlier test changes and unrelated suite type errors can obscure validation -> keep the pre-existing folder creation test change separate; report focused results and any unrelated baseline failures without weakening gates.

## Migration Plan

1. Ship additive host diagnostics and compatible readers; no persisted-data migration is needed.
2. Add shared explanation presentation and wire it into local, SSH, and paired-runtime result branches.
3. Qualify scanner-equivalence, cross-version fallback, renderer accessibility, and isolated hidden Electron scenarios before release.
4. Rollback by removing presentation and optional diagnostic emission. Existing scan payload fields, import behavior, and persisted workspaces remain compatible.
