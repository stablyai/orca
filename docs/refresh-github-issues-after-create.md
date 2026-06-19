# Refresh GitHub Issues After Create

## Problem

Issue https://github.com/stablyai/orca-internal/issues/101 reports that the GitHub issues list can stay stale after creating a new issue.

- `src/renderer/src/components/TaskPage.tsx:3891` bumps `taskRefreshNonce` after successful issue creation, intending to refetch the list.
- `src/renderer/src/store/slices/github.ts:1644` honors `force` only for the renderer cache and in-flight dedupe.
- `src/renderer/src/store/slices/github.ts:1666` calls `window.api.gh.listWorkItems` without telling main to bypass the GitHub CLI cache.
- `src/main/github/client.ts:821` and `src/main/github/client.ts:846` use `gh api --cache 120s` for the recent issues and PR REST paths, so a forced renderer refresh can still receive a pre-create response for up to two minutes.
- `src/main/runtime/rpc/methods/github.ts:10` and `src/main/runtime/rpc/methods/github.ts:283` do not accept or forward a cache-bypass flag for SSH/runtime clients.

## Root Cause

The post-create flow forces only Orca's renderer-side work-item cache. It does not bypass the GitHub CLI REST cache used by the main-process recent work-item fetch, so the refreshed request can reuse stale `gh api --cache 120s` data.

## Non-Goals

- Replace normal list caching or reduce default cache TTLs.
- Change query/search filtering behavior.
- Change GitLab, Linear, project view, or PR detail caches.
- Add polling after issue creation.
- Add new UI controls or visible copy.

## Design

1. Add an optional `noCache` flag to the renderer work-item fetch options and the GitHub work-items list contract:
   - `FetchOptions` in `src/renderer/src/store/slices/github.ts`;
   - preload API type and implementation for `gh.listWorkItems`;
   - IPC handler args for `gh:listWorkItems`;
   - web preload routing, which forwards `gh.listWorkItems` to `github.listWorkItems` for web/remote clients;
   - runtime RPC schema and handler for `github.listWorkItems`;
   - `OrcaRuntime.listRepoWorkItems`;
   - `listWorkItems` and the internal recent-list helper in `src/main/github/client.ts`.

2. Keep `force` and `noCache` separate. `force` means "bypass renderer cache and in-flight dedupe"; `noCache` means "bypass `gh api --cache`". In TaskPage, pass `{ force: forcedFetch || shouldProbeOnLanding, noCache: forcedFetch }` so nonce-triggered refreshes and preference invalidation bypass the GitHub CLI cache, while the one-time landing probe still behaves like today's background revalidation. Today `taskRefreshNonce` is shared by create, manual refresh, retry, filtering, preset changes, and PR merge refresh, so the implementation should either accept that whole nonce-triggered set as the no-cache scope or split create/manual refresh intent into a separate signal before narrowing it.

3. When `fetchWorkItems(..., { noCache: true })` calls `window.api.gh.listWorkItems`, pass `noCache: true`; otherwise omit it or pass `false`.

4. Track `noCache` alongside `force` in `inflightWorkItemsRequests`. A request with `noCache: true` must not dedupe onto an existing request with `noCache: false`, even if that existing request is forced; wait for the existing request to settle and issue a fresh no-cache request. This preserves the create path when it races a landing probe, which is `force: true` but intentionally cacheable.

5. In `listRecentWorkItems`, build REST args with `[]` when `noCache` is true and `['--cache', '120s']` otherwise. Apply this only to the REST `gh api` issue/PR list calls that currently use the cache. Keep fallback `gh issue list` / `gh pr list` and queried paths unchanged because they do not use this REST cache.

6. Preserve current force semantics:
   - non-forced loads keep using the 120-second CLI cache;
   - forced loads still wait out non-forced in-flight requests before issuing a fresh request;
   - no-cache loads also wait out cacheable in-flight requests before issuing a fresh request;
   - force continues to refresh all selected repos through the existing TaskPage effect.

7. Add regression coverage:
   - renderer store: `force + noCache` sends `noCache: true`; `force` without `noCache` and non-force calls omit it;
   - renderer store: `force + noCache` does not dedupe onto an in-flight `force` request that lacks `noCache`;
   - TaskPage or a focused equivalent: post-create/manual nonce path sets `noCache`, but landing probe does not;
   - desktop IPC: `gh:listWorkItems` forwards `noCache`;
   - web preload: `gh.listWorkItems` forwards `noCache` through the runtime route;
   - main GitHub client: `listWorkItems(..., { noCache: true })` omits `--cache 120s` on recent REST issue/PR calls;
   - runtime RPC: `github.listWorkItems` accepts and forwards `noCache`.

## Data Flow

- User creates GitHub issue in Tasks.
- `handleCreateNewIssue` bumps `taskRefreshNonce`.
- TaskPage effect computes `forcedFetch=true`.
- `fetchWorkItemsAcrossRepos` calls `fetchWorkItems` with `{ force: true, noCache: true }` for the nonce-triggered refresh.
- `fetchWorkItems` bypasses renderer cache and, when `noCache` is set, calls `gh.listWorkItems({ noCache: true })`.
- Desktop IPC or runtime RPC forwards `noCache`.
- `listRecentWorkItems` omits `gh api --cache 120s` for that fetch.
- GitHub returns a fresh recent issue list; cache is repopulated with the new issue.

## Edge Cases

- Multiple selected repos: all selected repos refresh through the existing fan-out; `noCache` applies only to `forcedFetch`, not the landing probe.
- Fork/upstream issue source: source resolution stays unchanged, and the cache bypass applies to whichever source is selected.
- SSH/runtime repo: runtime RPC accepts and forwards `noCache`, so remote clients do not retain the stale-cache bug.
- In-flight non-forced request: existing force logic waits for the stale request to settle, then issues a fresh no-cache request.
- In-flight forced landing probe: a nonce-triggered no-cache request must not dedupe onto the cacheable landing probe; otherwise create can still repaint from `gh api --cache 120s`.
- One-time landing probe: it still uses `force` to bypass renderer freshness, but must not set `noCache`; otherwise merely opening Tasks with cached rows would spend uncached GitHub API requests.
- Search query active: queried paths already use `gh issue list` / `gh pr list` rather than cached REST calls, so no behavior change is required.
- Pagination: next-page fetches use queried/cursor paths and do not populate the renderer work-items cache, so `noCache` is page-0-only.
- Concurrent windows: the creating window refreshes immediately; other renderer windows keep their own cache until their next refresh, landing probe, or TTL expiry. This change should not introduce cross-window invalidation.
- External GitHub mutations: external issue changes still rely on existing TTL/manual refresh behavior; this fix only guarantees freshness for Orca-originated create flows.
- Network/auth errors: existing partial-failure handling and banners remain unchanged.

## Test Plan

- Unit: extend `src/renderer/src/store/slices/github.test.ts` or add focused coverage for `fetchWorkItems` `force`/`noCache` IPC args and the no-cache-vs-cacheable-in-flight dedupe case.
- Unit: cover the TaskPage nonce path or isolate the option computation so nonce-triggered refreshes set `noCache` and the landing probe does not. If implementation narrows no-cache to a new create/manual-refresh signal, cover that narrower signal explicitly.
- Unit: extend `src/main/ipc/github.test.ts` to assert `gh:listWorkItems` forwards `noCache` to the client.
- Unit: extend `src/renderer/src/web/web-preload-api.test.ts` to assert web/remote `gh.listWorkItems` preserves `noCache`.
- Unit: extend `src/main/github/client-issue-source.test.ts` or `src/main/github/client-work-items.test.ts` to assert recent no-cache requests omit `--cache 120s` while normal recent requests keep it.
- Unit: extend `src/main/runtime/rpc/methods/github.test.ts` and/or `src/main/runtime/orca-runtime.test.ts` for `noCache` schema/forwarding.
- Typecheck: `pnpm typecheck`.
- Lint: `pnpm lint`.
- Electron validation: create an issue only in a throwaway/test repo if available; otherwise validate the refresh behavior with mocked/local unit tests and capture the Tasks issue list state without mutating live data.

## UI Quality Bar

Not UI-visible. The existing issue list UI and create-issue dialog should look unchanged; only freshness after a forced refresh changes.

## Review Screenshots

1. GitHub Tasks issue list after refresh/create path is reachable.
2. Create issue dialog before submission, if validation can use a throwaway repo.
3. Post-create issue detail/list state, only if validation can use a throwaway repo without mutating live user data.

## Rollout

1. Add `noCache` to renderer fetch options plus shared/preload/web/runtime IPC contracts.
2. Thread `noCache` through web routing, runtime, and desktop main-process handlers.
3. Apply `noCache` to the recent REST work-item list args.
4. Pass `noCache` from nonce-triggered renderer work-item fetches, but not landing probes.
5. Add regression tests.
6. Run typecheck, lint, and focused tests.

## Lightweight Eng Review

- Scope: reduced to force-refresh cache bypass for the existing work-item list path; no polling, UI changes, or TTL changes.
- Architecture/data flow: the renderer already owns refresh intent, while main owns GitHub CLI args. Thread `noCache` as explicit request metadata across preload, web preload, desktop IPC, runtime RPC, and SSH-aware runtime methods; do not infer it from every `force` call because landing probes also use `force`.
- Failure modes covered:
  - stale `gh api --cache 120s` response after create;
  - forced fetch deduping onto a non-forced in-flight request;
  - runtime/SSH clients lacking the cache-bypass argument;
  - upstream/origin issue-source selection still resolving before fetch;
  - queried path accidentally changing despite not using REST cache.
- Test coverage required:
  - renderer store IPC args for `force`/`noCache` combinations;
  - TaskPage option computation for nonce-triggered refresh vs landing probe;
  - desktop IPC and web preload forwarding;
  - main GitHub client recent-list REST args with and without `noCache`;
  - runtime RPC schema/handler forwarding `noCache`;
  - focused typecheck/lint.
- Performance/blast radius: low when `noCache` is limited to nonce-triggered refreshes and preference invalidation. Normal loads and landing probes keep the CLI cache; the no-cache path doubles the fresh REST calls for repos that have both issue and PR sources, so avoid broadening it to every renderer `force`.
- UI quality bar: not UI-visible; UI should remain unchanged apart from fresher rows.
- Required review screenshots:
  1. Tasks GitHub issues list reachable after implementation.
  2. Create issue dialog reachable, if a throwaway repo is available.
  3. Post-create or post-refresh list state, if validation can avoid mutating live data.
- Residual risks: validating the actual create flow may be skipped unless a safe throwaway GitHub repo is available; cross-window freshness and external GitHub mutations remain bounded by existing refresh/TTL behavior.
