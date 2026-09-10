# Coverage-hole audit

Three scenarios were added without changing adapters or runner behavior:

- `inventory-repeat-query`: normalize mixed-case queries, retain two cached queries,
  repeat one while another request is in flight, ignore its stale completion, and
  cancel a pending debounce by repeating the other cached query.
- `settings-repo-metadata-single-host`: two repositories on the same SSH host must
  send only `repo.list`, suppressing all three host-label lookups.
- `settings-bot-overrides-refresh-refused`: a successful fetch followed by a refused
  refresh on the same mount retains the prior bot overrides.

## Mutation evidence

Each source edit below was applied alone, with its anchor asserted to occur exactly
once, and restored before the next run. Every run used the entire recording suite:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording
```

The unchanged control returned `Test Files 3 passed (3)` and
`Tests 88 passed | 3 skipped (91)`. Counts below include the 13 runner-contract
checks and 11 declared mutant checks in addition to the 64 golden parity checks.

| Brief item | Source edit                                                               | Verdict      | Failed | Passed | Skipped | First difference                                                                                       |
| ---------- | ------------------------------------------------------------------------- | ------------ | ------ | ------ | ------- | ------------------------------------------------------------------------------------------------------ |
| 1          | Delete `if (sequenceRef.current !== sequence) { return }` in `applyPaths` | Killed       | 1      | 87     | 3       | `inventory-repeat-query`, `stale-search-ignored`, `state.files[0]`: alpha.ts → gamma.ts                |
| 2          | Replace cache lookup with `const cached = undefined`                      | Killed       | 1      | 87     | 3       | `inventory-repeat-query`, `cached-alpha`, `state.files`: [alpha.ts] → []                               |
| 2          | `FILE_SEARCH_QUERY_CACHE_LIMIT = 20` → `1`                                | Killed       | 1      | 87     | 3       | Same cached-alpha state difference                                                                     |
| 2          | `FILE_SEARCH_QUERY_CACHE_LIMIT = 20` → `0`                                | Killed       | 1      | 87     | 3       | Same cached-alpha state difference                                                                     |
| 3          | `query.trim().toLowerCase().slice(0, 256)` → `query.trim().slice(0, 256)` | Killed       | 1      | 87     | 3       | `Request params mismatch: files.searchPaths#1` (alpha → ALPHA)                                         |
| 4          | `hostIds.size > 1` → `hostIds.size >= 1`                                  | Killed       | 1      | 87     | 3       | `settings-repo-metadata-single-host`, `single-host-without-label-lookups`, sender gains three requests |
| 5          | Delete `setCachedRepos(requestHostId, repoResult.repos)`                  | **Survived** | 0      | 88     | 3       | None                                                                                                   |
| 6          | `if (stale \|\| !response.ok)` → `if (stale)`                             | Killed       | 1      | 87     | 3       | `settings-bot-overrides-refresh-refused`, `refused-retains-overrides`, state: [bot-user] → []          |
| 6          | `sourceClientRef.current !== client` → `false`                            | **Survived** | 0      | 88     | 3       | None                                                                                                   |

Each killed run returned `Test Files 1 failed | 2 passed (3)` and
`Tests 1 failed | 87 passed | 3 skipped (91)` (exit 1). Both surviving runs returned
`Test Files 3 passed (3)` and `Tests 88 passed | 3 skipped (91)` (exit 0).
Items 1–3 edit `mobile/src/session/use-mobile-native-chat-file-search.ts`; items 4–5
edit `mobile/src/host-screen/use-host-repo-metadata.ts`; item 6 edits
`mobile/src/session/use-pr-bot-author-overrides.ts`.

The two survivors cannot be exercised through the existing adapters:

- The repo metadata adapter never mounts `useNewWorkspaceRepositories`, and no
  adapter consumes its cross-module repo cache. A cache-consumer mount after the
  metadata fetch would be needed to observe removal of the cache write.
- The bot adapter closes over one client object. `reset` changes only the refresh
  key; `cutover` migrates the same stable logical client; remounting loses the old
  hook state. A same-mount client-identity replacement action would be needed.

No adapter capabilities, synthetic private-cache projections, or ineffective fourth
scenario were added, as the brief explicitly requires reporting missing capabilities
instead of adding machinery. All six holes are therefore **not** closed.

## Existing oracle and archived checks

Re-recorded with all product mutations restored:

```sh
cd mobile && RPC_FOUNDATION_RECORD=1 ORCA_BACKGROUND_LAUNCH=1 pnpm exec tsx scripts/rpc-recording.mts --record
```

Output: `Test Files 2 passed (2)`; `Tests 75 passed | 3 skipped (78)`.
Compared every existing golden against HEAD as parsed JSON: all 61 differ only in
`recorderSha256`; every other header field and every trace is identical. Three new
goldens bring the total to 64.

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording/pilot-recordings.test.ts -t 'kills'
```

Output: `Test Files 1 passed (1)`; `Tests 11 passed | 40 skipped (51)`.
All 11 declared mutants in `operation-mutations.ts` are still killed. The 40 skips
here are due to the name filter; the unfiltered recording suite has only three.

Removed registration of the eight permanently skipped `rejects bcba08b3e4` checks
without reference states. The b1/b2/b3 archived-tree checks remain opt-in. The README
now plainly states that archived-tree corroboration is unproven in CI. CI wiring
was left unchanged because no archived checkout is supplied; the always-running
in-memory mutant evidence is verified separately above.

## Required gates

All commands exited 0 with product sources restored.

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile typecheck
```

```text
$ tsc --noEmit
```

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test
```

```text
Test Files  521 passed (521)
     Tests  4326 passed | 6 skipped (4332)
```

```sh
cd mobile && ORCA_BACKGROUND_LAUNCH=1 pnpm format:check
```

```text
All matched files use the correct format.
```

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec oxlint --format github
```

```text
Found 0 warnings and 0 errors.
```
