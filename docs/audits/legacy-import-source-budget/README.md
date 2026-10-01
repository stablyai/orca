# Legacy import source byte budget

The production importer accepted a transcript larger than its existing 16 MiB
quota when the file grew between `stat()` and reading it. The fix applies that
same quota to consumed raw bytes and rejects the entire import before replacing
the journal. It does not import a truncated prefix.

## Reproduce

From the repository root, with dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --max-old-space-size=256 docs/audits/legacy-import-source-budget/reproduce.mjs
```

The script bundles the actual production importer and decoder twice. The baseline
restores the importer's UTF-8 stream and omits the new consumed-byte quota in
memory; the second run uses the current source. All other dependencies are
identical. Explicit file paths bypass discovery; a stub fails if discovery is
unexpectedly called. No historical checkout or local-only commit is required.

Each run creates one real temporary file containing a valid Claude message.
The controlled `stat` seam captures its original size, appends spaces until the
file is exactly 17 MiB, then returns the original stat. The production importer
reads the grown file. A journal spy records replacement attempts and its epoch;
no SQLite database or user transcript is touched. Temporary files are removed.

`results.json` records source hashes, actual consumed bytes, stream closure,
and replacement attempts. Before the fix the importer consumes all 17 MiB,
returns success, and replaces the journal with the decoded prefix. Afterward it
refuses on the first chunk crossing 16 MiB, destroys the stream, and leaves the
prior epoch untouched. Read buffering permits one chunk of overshoot.

## Process and version attribution

This importer runs in the host runtime through structured-session adoption,
handoff, transcript catch-up, and journal recovery. On desktop that runtime is
Electron main; a remote runtime imports its own host-local source. The stat-only
quota and unrestricted stream already existed in `v1.4.198`, release commit
`e0826956fcfc532f5a1e55b5e081f2e57e553c43`.

The reproduction establishes a quota bypass, not the cause of #19768 or #19831.
It requires an import and source growth/replacement after the size check;
neither incident provides that evidence. This fix is independent of #20963's
resumable JSONL record limit.

## Other whole-document audit results

- `ai-vault/session-transcript-reader.ts:152` routes rewritten JSON documents
  through whole-file `readFile` and `JSON.parse`. Gemini JSON, Hermes, Devin,
  Cline, Grok metadata, Kimi state, Rovo, and OpenCode file readers lack a source
  byte quota. These are allocation peaks; the parse cache retains summaries,
  not the full documents.
- The production default, including v1.4.198, places those scans in the forked
  AI Vault service with a 384 MiB V8 old-space limit. That is not a total RSS
  limit. `ORCA_AI_VAULT_SERVICE_PROCESS=0` instead puts scans in a worker thread
  sharing main's PID; its first-prompt fallback runs directly in main.
- Existing remote whole-document streaming parsers offer a reuse path, but
  local conversion must preserve message-sink delivery for search indexing.
  Streaming also needs an explicit policy for an individually oversized JSON
  value; arbitrary history truncation was not introduced.
- The older `native-chat/transcript-reader.ts` and `transcript-read-cache.ts`
  have whole-history behavior, including a newest-entry cache exemption, but
  the current production source has no external call sites for those exports.

Validation: 50 targeted tests passed, including a regression that failed before
the fix, UTF-8 and raw-byte limits, exact-boundary acceptance, and stream cleanup.
Node typecheck, targeted lint, formatting, and diff checks passed.
