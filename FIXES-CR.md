# CodeRabbit review fixes — PR stablyai/orca#6920

Addresses **every** CodeRabbit finding on the Gitea task-source PR: 16 inline
(Major) + 1 outside-diff + 11 Minor + 1 Nitpick = **29 findings**.

- **26 fixed / applied** (incl. one defensive hardening that isn't reachable today).
- **3 not actioned with justification** (1 confirmed unreachable, 1 inert as
  scoped/handled elsewhere, 1 false positive). Details below.

Work was scoped to the CodeRabbit review; the two prior validated fixes on this
branch (non-default-port host match; label-toggle delta) were **extended, not
reverted**, where findings overlapped.

## Validation

| Check | Result |
| --- | --- |
| `pnpm test` (Gitea main + renderer suites) | **117 passed** across 13 files |
| Adjacent suites (register-core-handlers, persistence, diffComments, task-providers) | **350 passed** |
| `pnpm run typecheck` (node + cli + web) | **pass** |
| `pnpm run build:web` | **pass** (`✓ built in 1m 46s`) |
| `pnpm run verify:localization-catalog` / `:coverage` | **pass** (parity + 0 untranslated) |
| `pnpm run lint` | green for all touched files (see *Pre-existing lint* note) |

Commits (logical groups, newest first):

```
refactor(gitea): extract focused modules to stay within max-lines
fix(gitea): localize remaining UI strings and per-server settings state
fix(gitea): correct Tasks-page drawers and review-panel refresh for Gitea
fix(gitea): key issue caches by active server and invalidate lists on update
fix(gitea): guard renderer work-item state against selection changes
fix(gitea): correct issue/PR read & write edge cases in the main process
fix(gitea): scope credentials by API-base subpath and fix auth-status 403
```

---

## Inline Major (16)

| # | Finding (file:line) | Status | What changed |
| --- | --- | --- | --- |
| 1 | `src/main/gitea/client.ts:104-108` — 403-as-authenticated token path | ✅ Fixed | `getGiteaAuthStatus()` now reuses `fetchGiteaUser` (exported from `connect.ts`) for the token probe instead of `giteaGetJsonAtBase`, which returned `null` for a 403. A read:user-scope 403 now reports `authenticated: true, account: null`, matching connect. |
| 2 | `src/main/gitea/connect.ts:58-63` — only special-case the scope 403 | ✅ Fixed | The `/user` 403 branch now reads the body and only accepts it when it matches `required scope(s): [read:user]`; every other 403 returns `{ ok: false }`. |
| 3 | `src/main/gitea/issues.ts:53-60, 74-79` — search page size vs result cap | ✅ Fixed | The owner-wide search now requests `limit: MAX_LIMIT` per page (and breaks on a short page by `MAX_LIMIT`), decoupled from the requested `max`, so a small limit can't under-scan before repo filtering. |
| 4 | `src/main/gitea/issues.ts:266-280` — full failure after a committed PATCH | ✅ Fixed | `updateGiteaIssue` tracks whether the field PATCH committed; if the labels PUT then fails, it returns `{ ok: true, warning }` (new optional field on `GiteaMutationResult`) so the UI still refreshes the changed issue while surfacing the label failure as a non-fatal toast. |
| 5 | `src/main/gitea/mappers.ts:114-115` — trimmed issue body | ✅ Fixed | `body: raw.body ?? undefined` (was `raw.body?.trim() \|\| undefined`) so the raw Markdown isn't rewritten on read. Extends the prior mapper fix in this area. |
| 6 | `src/main/gitea/pull-requests.ts:140-143` — PR file list stops at page 1 | ✅ Fixed | `listGiteaPullRequestFiles` now pages (`limit 100`, up to `MAX_PR_FILES_PAGES = 50`) and merges all files, so large PRs don't drop changed files. |
| 7 | `src/main/gitea/request.ts:41-65` — env token scoped by host only | ✅ Fixed | `resolveGiteaAuth` compares the **normalized host + API-base path** (`sameApiBase` via `giteaServerKey`) and passes `repo.apiBaseUrl` + the host-inferred flag into the stored lookup, so `ORCA_GITEA_TOKEN` can't leak to a sibling subpath instance. Builds on (keeps) the #5493 host+port match. |
| 8 | `src/main/gitea/server-store.ts:250-270` — stored creds by host only | ✅ Fixed | Added `giteaServerKey(apiBaseUrl)` (host+path, port-preserving). `getServerForHost(host, apiBaseUrl?, apiBaseFromHost?)` prefers an exact host+path match; for a **host-inferred** base it accepts the host's lone connected server, refusing to guess when multiple instances share a host. Both callers (`request.ts`, `issues.ts`) pass the API base + flag. |
| 9 | `src/renderer/.../GiteaIssueWorkspace.tsx:149-163` — guard async writes | ✅ Fixed | `refreshDetail`, `handleToggleState`, and `handleSubmitComment` capture `requestRef.current` before the await and bail if the selection changed, so a late response can't overwrite a newly-opened issue. |
| 10 | `src/renderer/.../GiteaPullRequestWorkspace.tsx:134-228` — guard PR mutations | ✅ Fixed | `handleSubmitComment`, `handleMerge`, and `handleAddReviewComment` apply the same `requestRef` guard after each awaited IPC call. |
| 11 | `src/renderer/.../GiteaTaskList.tsx:92-106` — one repo blanks the list | ✅ Fixed | Load uses `Promise.allSettled`, merges fulfilled repos, logs rejected ones, and only shows the error banner when **every** repo failed. |
| 12 | `src/renderer/.../TaskPage.tsx:6620-6629` — clear the opposite drawer | ✅ Applied (defensive) | `handleOpenGiteaItem` clears the opposite selection so the two drawers are mutually exclusive. **Verified not currently reachable** (both are modal sheets; every close path nulls the opposite selection first), but the structural gap is real, the fix matches CR, and it future-proofs against a non-modal/non-list opener. |
| 13 | `src/renderer/.../gitea-issue-meta-controls.tsx:45-46` — reset title draft | ⏭️ Skipped (unreachable) | See *Not actioned* below — confirmed the prior review's conclusion: the drawer unmounts on issue switch, so `useState(title)` always re-initializes for the new issue. |
| 14 | `src/renderer/.../right-sidebar/ChecksPanel.tsx:2519-2531` — GitHub refresh after Gitea mutation | ✅ Fixed | `refreshHostedReviewAfterMutation` gains a `provider === 'gitea'` branch that refreshes via `refreshHostedReviewCard` + `fetchGiteaDetails` and returns, instead of falling through to the GitHub PR force-refresh. Deps updated. |
| 15 | `src/renderer/.../store/slices/gitea.ts:84-89` — cache key by selection only | ✅ Fixed | `scopeKey` now keys unpinned entries by `activeServerId` (→ `selectedServerId` → `'all'`); all four call sites pass `get().giteaStatus`. Two single-server states no longer collapse to one key. |
| 16 | `src/renderer/.../store/slices/gitea.ts:209-223` — stale lists after mutation | ✅ Fixed | `updateGiteaIssue` now also drops the cached work-item lists for the scope (prefix match), not only the detail entry. |

## Outside-diff range (1)

| # | Finding | Status | Notes |
| --- | --- | --- | --- |
| 17 | `src/renderer/.../store/slices/ui.ts:1228-1233` — Gitea treated as globally available | ⏭️ Addressed via F11; `ui.ts` unchanged | As scoped to these lines the edit is **inert**: `giteaConfigured` only feeds `resolvedSource`, and `openTaskPage` never branches on `resolvedSource === 'gitea'` (only github/linear prefetch), so the value can't reach `GiteaTaskList`. The stated failure mode (one unsupported repo rejecting the whole load) is fully fixed by **F11** (`Promise.allSettled`). A real per-repo "is Gitea-backed" filter isn't determinable in the renderer today (`Repo` has no Gitea provider/apiBase field), so the load-path fix is the correct split. |

## Minor (11)

| # | Finding (file:line) | Status | What changed |
| --- | --- | --- | --- |
| 18 | `src/main/ipc/gitea.ts:57-78` — empty/array update payloads | ✅ Fixed | `normalizeIssueUpdate` rejects arrays and payloads with no recognized field, so a no-op update can't skip every write and still report success. |
| 19 | `src/main/ipc/gitea-pr.ts:58-66` — file contents with empty refs | ✅ Fixed | Returns the empty content shape when `baseSha`/`headSha` is missing, so the diff never renders against an unintended ref. |
| 20 | `zh.json:6283-6285` (Settings-search keyword) | ✅ Fixed (corrected) | The keyword catalog is `tasks-search.ts` + the `settings.tasks.search` object in all 5 locales (not a literal key). Added `translateSearchKeyword(... .ae660a757a, 'gitea')` and the `ae660a757a` key to en/es/ja/ko/zh. |
| 21 | `src/renderer/.../task-source-context-summary.ts:53` — Gitea repo contexts | ✅ Fixed | `TaskPage` now builds `taskSourceRepoContexts` for `'gitea'` too, so the header summary reflects the selected projects instead of the zero-repo fallback. |
| 22 | `ja.json:12172-12320` — duplicate `gitea` key | ⏭️ Skipped (false positive) | The two keys live at **different paths** (`auto.components.settings.gitea` vs `auto.components.gitea`) — JSON keeps both; nothing is overwritten. Merging would *break* the integration-card lookups. Same layout in all 5 locales; none is affected. |
| 23 | `src/renderer/.../gitea-issue-comments.tsx:7-10` — localize "recently" | ✅ Fixed | The invalid-date fallback is routed through `translate()`. |
| 24 | `src/renderer/.../right-sidebar/ChecksPanel.tsx:674-676` — gate GitHub refresh on Gitea | ✅ Fixed | The `enqueueGitHubPRRefresh` effect now also excludes `isGiteaReviewContext`, not only GitLab. |
| 25 | `src/renderer/.../GiteaPullRequestWorkspace.tsx:101-129` — loading clears too early | ✅ Fixed | The load `.then` is now `async` and awaits `prChecks` (try/catch) before the chained `.finally` clears `loading`, so the Checks tab doesn't flash empty. |
| 26 | `src/renderer/.../gitea-pr-merge-button.tsx:33-40` — translate merge methods | ✅ Fixed | A `mergeMethodLabel()` function (re-evaluates on locale change) replaces the raw enum values. |
| 27 | `src/renderer/.../gitea-pr-file-diff.tsx:27-34` — localize status badges | ✅ Fixed | A `statusLabel()` function replaces the hardcoded `STATUS_LABELS` const (added/modified/…). |
| 28 | `src/renderer/.../settings/gitea-integration-card.tsx:21-25,43-80` — single testingServerId | ✅ Fixed | Test state is now a `Set<string>` so concurrent server tests can't clear each other's spinner. |

## Nitpick (1)

| # | Finding | Status | What changed |
| --- | --- | --- | --- |
| 29 | `src/renderer/.../settings/IntegrationsPane.tsx:55-58` — why-comment | ✅ Fixed | Added one-line why-comments at both Gitea cards explaining the cross-provider (review + task) design. |

---

## Not actioned — justification

- **F13 — `gitea-issue-meta-controls.tsx` title-draft reset (Major, skipped).**
  Verified **not reachable**. `GiteaIssueMetaControls` is rendered inside
  `GiteaIssueWorkspace`'s `{selection && item && repo ? … : null}` gate and is
  unkeyed. The drawers are modal Radix sheets, and the only opener
  (`handleOpenGiteaItem`) is reached via task-list clicks that the modal overlay
  blocks while a sheet is open. Switching issues therefore always goes
  A → close (`selection = null`, which unmounts the controls) → B, so
  `useState(title)` re-initializes to issue B's title every time. The wrong-issue
  rename cannot occur. (If the sheets ever become non-modal, keying the component
  by `issueNumber` is the one-line fix.)

- **F17 — `ui.ts` `giteaConfigured` (outside-diff, handled elsewhere).** Inert as
  scoped; the actual failure mode is fixed by F11. See the Outside-diff row above.

- **F22 — `ja.json` duplicate `gitea` key (Minor, false positive).** The two keys
  are at distinct JSON paths; no overwrite occurs. See the Minor table.

## Tests added / adjusted

- `client.test.ts` — subpath-override test now uses a matching subpath remote;
  added (a) env token with a non-matching subpath → token not applied, request
  to repo base; (b) read:user-scope 403 → authenticated, no account; (c)
  non-scope 403 → unauthenticated.
- `connect.test.ts` — non-scope 403 rejects and stores nothing.
- `server-store.test.ts` — `giteaServerKey` host+path/port/trailing-slash/invalid.
- `issues.test.ts` — search `limit` is now 100 (page size); PATCH-commits-then-
  labels-fail → `{ ok: true, warning }`; labels-only failure → `{ ok: false }`.
- `pull-requests.test.ts` — file-list pagination across a full + short page.
- `gitea.test.ts` (slice) — cache keys are `active:*`; update invalidates the
  work-item list; reconnect to a different `activeServerId` keeps caches distinct.
- `task-source-context-summary.test.ts` — Gitea repo-backed summary.
- `gitea-integration-card.test.tsx` — per-server testing state (one finishing
  doesn't clear another).
- `settings-search-keywords.test.ts` — Tasks-pane search indexes `gitea`.

## Self-review (adversarial)

An adversarial pass over the committed diff caught one **regression in the F7/F8
credential scoping**: SSH clone URLs (`git@host:owner/repo.git`) can't carry the
host's web ROOT_URL subpath, so a subpath-hosted Gitea accessed via an SSH remote
derived a bare-host `apiBaseUrl` that no longer key-matched the stored server's
subpath base — dropping the token (reads → null, writes → "Connect a Gitea
account"). Fixed by flagging such bases as **host-inferred** (`GiteaRepoRef.apiBaseFromHost`,
set in `repository-ref.ts` only for SSH/SCP remotes with no subpath segment) and
allowing a host-only credential match for that case alone — while keeping the
strict exact-match for authoritative HTTP bases and refusing to guess between
multiple instances on one host. Covered by new tests in `repository-ref.test.ts`
and `client.test.ts`. (Commit: *keep SSH-remote subpath repos authenticated*.)

## Notes for the reviewer

- **Refactor commit.** The selection-race guards and PR-file pagination pushed
  three files past their `max-lines` budgets. Per the repo guideline (never
  disable `max-lines`), three focused modules were extracted —
  `pull-request-reviews.ts`, `gitea-workspace-chrome.ts`, `gitea-pr-tabs.ts` —
  with no behavior change.
- **Pre-existing lint.** `pnpm run lint` reports a few errors that **pre-date**
  this work and are outside the CodeRabbit review scope, e.g.
  `automations/automation-target-availability.ts` (`max-lines`, never touched
  here) and `unicorn/prefer-node-protocol` on existing imports in
  `server-store.ts` / `ipc/gitea-repo-access.ts`. They were left as-is to keep
  this change scoped to the review; no new lint errors were introduced.
