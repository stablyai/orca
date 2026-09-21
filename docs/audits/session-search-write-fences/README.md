# Session-search write fence retention

The search writer remembered every removed path for its lifetime. Those counters
fenced a read whose source disappeared before its first commit: both the original
and deleted database cursors are absent, so comparing cursors alone cannot detect
the removal. Counters for paths with no remaining reads were never released.

The fix tracks only active reads. Removal marks their captured lifetime as removed
and releases the path from the map immediately. New reads get a fresh lifetime;
cleanup from an older read cannot delete it. Final commit and explicit discard
release ownership, while intermediate chunk commits keep it. Consumer errors,
incomplete reads, throwing error reporters, and store close release their fences.

## Reproduce

From the repository root with dependencies installed and a Node version providing
`node:sqlite`:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --max-old-space-size=128 docs/audits/session-search-write-fences/reproduce.mjs
```

The script bundles the actual writer twice, using the production SQLite schema and
adapter. The baseline is published commit
`243f4431557471daa05636aed1a30be790485eda` (#20551), whose writer matches the pre-fix
source. The after version is the working tree. Only this named Git object is read;
the script fetches nothing. Results include both source hashes and runtime details.

After 1,000 complete index/retire cycles:

| Source | Remaining file rows | Retained path entries | Never-indexed stale commit accepted |
| ------ | ------------------: | --------------------: | ----------------------------------- |
| Before |                   0 |                 1,000 | No                                  |
| After  |                   0 |                     0 | No                                  |

The regression suite additionally drives the actual consumer/channel path, checks
intermediate flush ownership, failed/incomplete reads, throwing error reporters,
new-generation protection, idempotent discard, and close:

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/ai-vault-search/session-search-write-lifetime.test.ts src/main/ai-vault-search/session-search-file-write.test.ts src/main/ai-vault-search/session-search-index-writer.test.ts src/main/ai-vault-search/session-search-index-consumer.test.ts
```

Existing retry bookkeeping can recreate a failed `files` metadata row when a
removed read finishes. Its session/messages stay absent and it cannot restore
searchable content. This patch preserves that status policy.

This is current-code path metadata in the scanner child. The search writer did not
exist in `v1.4.198`; this finding does not explain the reported #19831/#19768 build.
