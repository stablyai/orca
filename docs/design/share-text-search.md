# Design: Share Text Search Logic Between Local Main and SSH Relay

**Branch:** `fix-ssh-keywords-search`
**Status:** Draft

## Problem

The right-sidebar keywords search (`fs:search`) and the Cmd+P quick-open file search historically shared no code between the local main process and the SSH relay. Each side reinvented: rg argument construction, rg `--json` stdout parsing, the git-grep fallback, the submatch regex, the `SearchFileResult` accumulator, and the "kill previous search on new query" logic.

This drift already caused one user-visible bug: the relay's `searchWithRg` in `src/relay/fs-handler-utils.ts:139` uses `execFile('rg', ..., { maxBuffer: 50 * 1024 * 1024 })`. `execFile` buffers stdout internally and kills the child when `maxBuffer` is exceeded, even when `data` listeners are attached. Under rg's `--json` output (one verbose JSON object per match), 50MB fills well before the match cap in large folders. The `child.once('error', () => resolveOnce())` then silently resolves with whatever was accumulated — users see "some files can't be found" with no error.

The local handler at `src/main/ipc/filesystem.ts:402` uses `wslAwareSpawn` (plain `spawn`) and has never had this bug. The two paths must not be allowed to drift again.

## Scope

**In scope:**
- Extract rg + git-grep search logic into `src/shared/text-search.ts`, matching the pattern already established by `src/shared/quick-open-filter.ts` for listFiles.
- Remove the `execFile`/`maxBuffer` footgun from the relay path.
- Unify the accumulator, truncation semantics, and submatch regex construction.

**Out of scope:**
- Changing the `fs.search` request shape or existing `SearchResult`/`SearchOptions` fields.
- Adding new search features (multiline, semantic, etc).
- Changing how quick-open lists files (already shared via `quick-open-filter.ts`).
- Re-homing WSL path translation — that stays in the local main process; the relay never sees WSL paths.

## Existing Code Map

| Concern | Local (main) | Remote (relay) |
|---|---|---|
| rg `--json` run + parse | `src/main/ipc/filesystem.ts:286-441` (inline in IPC handler) | `src/relay/fs-handler-utils.ts:78-231` (`searchWithRg`) |
| git-grep fallback | `src/main/ipc/filesystem-search-git.ts:43-220` (`searchWithGitGrep`) | `src/relay/fs-handler-git-fallback.ts:140-297` (`searchWithGitGrep`) |
| rg availability check | `src/main/ipc/rg-availability.ts` (`checkRgAvailable`) | `src/relay/fs-handler-utils.ts:241-260` (`checkRgAvailable`) |
| rg arg construction | inline in filesystem.ts | inline in fs-handler-utils.ts |
| git-grep arg construction | inline in filesystem-search-git.ts | inline in fs-handler-git-fallback.ts |
| Submatch regex | `filesystem-search-git.ts:115-119` | `fs-handler-git-fallback.ts:200-204` |
| Accumulator (fileMap, totalMatches, truncated) | duplicated in all four files | duplicated in all four files |
| Relative-path normalization | `normalizeRelativePath` (collapses `\\`/`/`, strips leading slashes) | plain `.replace(/\\/g, '/')` |
| git-grep signature | `searchWithGitGrep(rootPath, args, maxResults)` (maxResults positional) | `searchWithGitGrep(rootPath, query, opts)` (maxResults inside opts) |
| Process spawn | `wslAwareSpawn` (local) / `gitSpawn` (local) | `execFile` (rg, buggy) / `spawn` (git) |

Net duplicate: ~400 lines across four files that do nearly the same thing.

## Design

### New module: `src/shared/text-search.ts`

Pure, IO-agnostic helpers. No Electron, no child_process, no fs. Mirrors `quick-open-filter.ts` — the caller owns process execution and transport-specific path quirks.

```ts
// Types (re-exported from shared/types or defined here)
export type SearchAccumulator = {
  fileMap: Map<string, SearchFileResult>
  totalMatches: number
  truncated: boolean
}

export function createAccumulator(): SearchAccumulator

// ── rg ─────────────────────────────────────────────────────────────
// Returns the full argv including '--', query, and target. Both callers
// pass `rootPath` unchanged as the target — the local side does NOT
// translate the target to a WSL-native path. WSL only affects the
// invocation (via `wslAwareSpawn`) and the *output* paths rg emits,
// which the caller translates back via `transformAbsPath` below.
export function buildRgArgs(
  query: string,
  target: string,
  opts: SearchOptions
): string[]

// Ingest one rg --json stdout line. Mutates `acc`. Returns 'continue'
// or 'stop' (stop = totalMatches hit maxResults). Takes an optional
// path transform so the local caller can apply WSL translation.
export function ingestRgJsonLine(
  line: string,
  rootPath: string,
  acc: SearchAccumulator,
  maxResults: number,
  transformAbsPath?: (p: string) => string
): 'continue' | 'stop'

// ── git grep ───────────────────────────────────────────────────────
// Also owns include/exclude glob → git pathspec translation
// (`toGitGlobPathspec`), which today is duplicated inline in both
// `filesystem-search-git.ts` and `fs-handler-git-fallback.ts`.
export function buildGitGrepArgs(
  query: string,
  opts: SearchOptions
): string[]

// Build the submatch regex used to locate column positions within a
// matched line (git grep only reports the first hit per line).
export function buildSubmatchRegex(
  query: string,
  opts: { useRegex?: boolean; wholeWord?: boolean; caseSensitive?: boolean }
): RegExp

export function ingestGitGrepLine(
  line: string,
  rootPath: string,
  submatchRegex: RegExp,
  acc: SearchAccumulator,
  maxResults: number
): 'continue' | 'stop'

// ── finalize ───────────────────────────────────────────────────────
export function finalize(acc: SearchAccumulator): SearchResult
```

### What stays environment-specific

| Stays local | Stays in relay |
|---|---|
| `wslAwareSpawn`, `gitSpawn` | plain `spawn` |
| `parseWslPath` / `toWindowsWslPath` transform passed to `ingestRgJsonLine` | no-op transform |
| `activeTextSearches` kill-on-new-query map keyed by `sender.id` | single-search-at-a-time per client (already one channel) |
| `resolveAuthorizedPath` | `context.validatePathResolved` |
| `checkRgAvailable` wrapping `wslAwareSpawn` (accepts a `searchPath` for WSL resolution) | `checkRgAvailable` wrapping plain `execFile` (no WSL) |

### Call sites after refactor

**`src/main/ipc/filesystem.ts`** shrinks from ~180 lines of search logic to ~40:
```
const rgAvailable = await checkRgAvailable(rootPath)
if (!rgAvailable) return searchWithGitGrep(rootPath, args, maxResults)

const acc = createAccumulator()
const rgArgs = buildRgArgs(args.query, rootPath, args)
const child = wslAwareSpawn('rg', rgArgs, { cwd: rootPath, stdio: ... })
activeTextSearches.get(searchKey)?.kill()
activeTextSearches.set(searchKey, child)
// stream stdout → ingestRgJsonLine(line, rootPath, acc, maxResults, wslTransform)
// on 'stop' → child.kill()
// on close/error → resolve(finalize(acc))
// timeout → set acc.truncated = true, child.kill()
```

**`src/main/ipc/filesystem-search-git.ts`** becomes a thin wrapper around `buildGitGrepArgs` + `ingestGitGrepLine`. File drops from 220 → ~80 lines.

**`src/relay/fs-handler.ts::search`** and the relay's rg/git-grep helpers: identical shape to the local caller, minus the WSL transform and `activeTextSearches` tracking. `searchWithRg` in `fs-handler-utils.ts` is deleted; its callers inline the spawn loop or we keep a thin relay-side wrapper (`src/relay/fs-handler-search.ts`).

**Critical:** the relay's rg caller uses `spawn`, not `execFile`. This alone fixes the reported bug.

### Signature + path normalization (unified)

The shared helpers settle two small existing asymmetries:

- git-grep callers in main and relay take `maxResults` differently today (third positional arg vs. folded into opts). The shared `buildGitGrepArgs` / `ingestGitGrepLine` take `maxResults` on the accumulator-ingest side only, so callers no longer invent their own shape.
- Relative-path normalization is unified on `normalizeRelativePath` (collapse mixed separators, strip leading slashes). The relay's plain `replace(/\\/g, '/')` is replaced, removing a drift seam that would surface the first time someone passed a path with a leading slash through the relay.

### Truncation semantics (unified)

One rule: `acc.truncated = true` if and only if rg/git-grep would have emitted more matches after we stopped consuming. Specifically:

- `maxResults` reached while processing submatches for a match record → truncated.
- Kill-timeout fires → truncated.
- rg/git-grep exits with non-zero status → *not* truncated; this is a clean "no results or early termination" path. (Matches current local behavior.)

This removes the existing inconsistency where the relay's `execFile` maxBuffer overflow silently returned `truncated: false` despite dropping matches.

**Ordering invariant (do not break during migration).** Today the caller flips `truncated = true` synchronously in the same tick it calls `child.kill()`, before the `close` handler resolves the promise. The shared module must preserve that ordering: `ingestRgJsonLine` / `ingestGitGrepLine` mutate `acc.truncated` synchronously when they return `'stop'`, and the caller must kill the child *after* that mutation. If a naive refactor moves the kill inside the helper but leaves `truncated` setting in the caller — or vice versa — a `close` event can resolve the promise with `truncated: false` even though matches were dropped. This is the exact silent-truncation footgun the refactor is meant to kill; regressing it reintroduces the original bug in a harder-to-spot form.

### Regex parity

`buildSubmatchRegex` centralizes the "escape literal query, wrap in `\b` for whole-word, add `gi` flags" logic currently in two files. Includes the zero-length-match guard (`matchRegex.lastIndex++` when `m[0].length === 0`) that the relay version also has but that would regress if one side is touched without the other.

## Migration Plan

1. **Land the shared module with tests.** Unit tests live at `src/shared/text-search.test.ts`, modeled on `src/shared/quick-open-filter.test.ts`. Cover: arg construction (every flag combination), rg JSON line ingestion (match/non-match/malformed/multi-submatch/maxResults boundary), git-grep line parsing (null-byte delimiter, colons in filenames, unicode, zero-length regex), and finalize shape.

2. **Migrate the local path.** Replace the inline rg loop in `filesystem.ts` and rewrite `filesystem-search-git.ts` to use the shared helpers. Existing `filesystem-list-files.test.ts` + `filesystem.test.ts` catch regressions; add a test specifically for the `execFile` → `spawn` equivalence (large result set that would have overflowed 50MB under `execFile`).

3. **Migrate the relay path.** Replace `searchWithRg` (`execFile` → `spawn`) and consolidate `fs-handler-git-fallback.ts`'s search half. Delete `searchWithRg` and the relay's git-grep duplicate once the last caller is gone.

4. **Drift guard.** Add a short comment at the top of `shared/text-search.ts` pointing to this design doc and naming both call sites. The existing comment at the top of `shared/quick-open-filter.ts` is the template.

## Non-goals / Explicit Non-changes

- **Not merging `checkRgAvailable`.** Both versions already agreed (no caching — see the "Why no cache" comments in `src/main/ipc/rg-availability.ts` and `src/relay/fs-handler-utils.ts`), but they wrap different spawn primitives: the local side runs through `wslAwareSpawn` and accepts a `searchPath` so WSL distro resolution works, while the relay uses plain `execFile`. Sharing would force one side to import the other's spawn wrapper. Two thin files, one contract.
- **Not unifying spawn.** `wslAwareSpawn` and `gitSpawn` carry WSL and git-auth concerns the relay has no business with.
- **Not changing the request shape or existing result fields.** `SearchOptions` stays as-is, and
  `SearchResult` keeps the same required fields. Long-line clamping may add optional display-only
  coordinates to a match so the sidebar can highlight bounded snippets without corrupting the
  source `column`/`matchLength` used for editor reveal.
- **Not touching the renderer.** `right-sidebar/Search.tsx` and `QuickOpen.tsx` are unchanged.

## Risks

- **Test coverage for relay search is thin.** Current tests exercise the local path. Plan: port the new shared-module tests plus add a relay-specific integration check (`fs-handler` test that streams a large mock rg stdout through the `spawn`-based loop to confirm no drop).
- **Behavioral parity is not 1:1 today.** The local path has WSL translation; the relay does not. Parity we're preserving is output *shape*, not output *paths*. Tests must not assume absolute-path equality across the two callers.
- **Kill-previous-search is only local.** The relay can process multiple concurrent `fs.search` requests over the mux. If that becomes a problem, add relay-side cancellation later — it is not part of this refactor.
