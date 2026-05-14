# GitHub Work Item Drawer: Cache & Latency

## Problem

`GitHubItemDialog` clears `details` to `null` on every open and waits for `gh:workItemDetails` before rendering. Reopening the same item therefore pays full IPC + `gh` process startup latency again.

The slow path is mostly process overhead and fan-out in `src/main/github/work-item-details.ts`, not GitHub API quota.

## What is true today

- `gh api --cache` reduces network/API pressure, but it does not remove local process startup, JSON parsing, or IPC serialization.
- A 304 response does not consume primary REST rate-limit quota, but it is still a network round-trip. With `--cache`, many calls are served from local cache anyway.
- The issue details path is currently multi-call:
1. `getWorkItem` (`/issues/:n` or PR fallback).
2. `getIssueBodyAndComments` (`/issues/:n` and `/issues/:n/comments`).
3. `getWorkItemParticipants` (GraphQL participants).
4. `getMentionParticipants` (GraphQL user hydration for visible authors).

So “3 spawns” understates the real hot path.

## Goals

- Reopen latency should be near-instant for recently viewed items.
- Cold issue-open latency should drop by reducing `gh` command count.
- Correctness must survive local mutations, repo/source switches, and multi-window usage.

## Non-goals

- No disk-persistent cache in this iteration.
- No attempt to replace PR files/diff path with GraphQL.

## Design

### 1. Renderer SWR cache with paint-first reads

Add a module-level LRU cache in `GitHubItemDialog.tsx` keyed by:

`repoPath + issueSourcePreference + type + number`

Cache value:

- `details`
- `fetchedAt`
- `pending?: Promise`
- `error?: string`

Behavior:

1. On open, render cached `details` immediately when present (do not clear to `null`).
2. If entry age <= `FRESH_MS` (30s), skip fetch.
3. If stale or missing, fetch in background and replace cache + UI when resolved.
4. On fetch failure with cached data, keep stale data visible and show non-blocking error state.
5. On fetch failure without cached data, show blocking error state.

### 2. In-flight dedupe in renderer

Store a single pending promise per key in the same cache entry. Concurrent opens/re-renders for the same key must await the same promise.

This dedupe must be keyed the same as the data cache key to avoid cross-repo or cross-source collisions.

### 3. Explicit invalidation rules

“Background refetch is authoritative” is necessary but not sufficient.

Invalidate (or patch + mark stale) on successful local mutations:

- issue state/labels/assignees/body edits
- new comments/reactions
- PR review comment create/resolve

Scope:

- per-item key in current window
- broadcast to other windows via main-process event (`gh:workItemMutated`) so their caches invalidate too

Also invalidate on context switches:

- `repoPath` change
- issue source preference change (`origin`/`upstream`/`auto`)
- sign-out/account change

For out-of-band mutations (web UI/other tools), rely on TTL + manual refresh action in drawer header.

### 4. Main-process issue fetch collapse (GraphQL-first)

Do not claim “one call returns everything” unless we actually ship and verify it.

Feasible single GraphQL issue query fields:

- issue body
- labels
- assignees
- participants
- comments(first: N) with author login + avatarUrl + body + createdAt + url

Limits and required fallbacks:

- GraphQL pagination still applies (`first: 100`). More comments require paging.
- Some comment authors can be null/ghost; renderer must keep existing fallback behavior.
- If GraphQL fails (permissions, partial errors), fall back to current REST+GraphQL path.
- Keep `getMentionParticipants` only if query omits non-participant visible authors; otherwise remove it.

PR path remains unchanged in this doc. PR file/diff/check behavior is intentionally out of scope.

## Edge cases this design must handle

- Reopen same item after optimistic comment: optimistic comment must survive stale cache reads until authoritative fetch includes it.
- Switching between upstream/origin issue source with same issue number must never reuse the wrong cache entry.
- Item-type collision (`issue #123` vs `pr #123`) must never reuse cache entry.
- Drawer close/open races: stale request responses must still be dropped (`requestIdRef` guard stays).
- Unauthorized/404 should not overwrite valid cached data with empty shells.

## Rollout

1. Implement renderer SWR + in-flight dedupe + stale-on-error behavior.
2. Add mutation-driven invalidation and cross-window invalidation event.
3. Implement GraphQL-first issue details with strict fallback.
4. Keep telemetry: measure open-to-first-paint and open-to-fresh-data before/after.
