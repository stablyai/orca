# AI Vault scanner late cancellation

The scanner child kept cancellation IDs after their requests had already settled.
Its response can still be in transit when the parent sends a cancellation, so this
does not require an invalid caller. The completed request has already run its
cleanup; nothing remains to delete the newly inserted ID.

The fix admits cancellation only while the existing `pending` set owns the request.
That set includes both queued and running requests. Their cancellation and cleanup
remain unchanged. No protocol or history-retention policy changes.

## Proof

Run from the repository root with dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --max-old-space-size=128 docs/audits/scanner-late-cancel/reproduce.mjs
```

The script loads the checked-out production entry and derives the before version by
removing only the three-line `pending` membership guard in memory. It checks that
the guard occurs exactly once; no historical commit or Git access is needed.
Esbuild strips TypeScript before both versions run in separate VM contexts. Only
imported collaborators are stubbed: the production message handler, request lanes,
sets, and cleanup run. After each synthetic first-prompt request completes, its
matching cancel arrives.

The script asserts the counts and emits JSON with both source SHA-256 hashes and
Node/platform/heap-limit provenance. [results.json](./results.json) records a run on
Node v26.6.0 with a 128 MiB old-space limit. This measures retained entries, not RSS.

| Source | Requests/responses | Pending | Controllers | Retained cancel IDs |
| ------ | -----------------: | ------: | ----------: | ------------------: |
| Before |      1,000 / 1,000 |       0 |           0 |               1,000 |
| After  |      1,000 / 1,000 |       0 |           0 |                   0 |

The regression test imports the production entry and directly observes its existing
cancellation set through an admitted cancellation. It repeats late cancels after
both successful and failed requests, verifies queued/running cancellation, and
checks shutdown cleanup. No production diagnostics or test-only exports were added.

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/ai-vault/session-scanner-service-cancellation.test.ts src/main/ai-vault/session-scanner-service-entry.test.ts src/main/ai-vault/session-scanner-service-client.test.ts
```

## Incident scope

The same unconditional insertion exists in release `v1.4.198`. This retains numeric
IDs in the scanner child, not transcript contents in Electron main. It is a concrete
small leak; it does not explain the reported roughly 26 MB/s main-process growth in
#19768 or establish the cause of #19831's scope-level peak memory measurements.
