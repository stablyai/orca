# Antigravity measured usage

Related issue: https://github.com/stablyai/orca/issues/21071

The November 6 closure says Antigravity transcripts lack token/model/cost fields.
Newer native CLI transcripts contain measured `input_tokens`, `cache_read_tokens`,
`output_tokens`, and `model` on completed `MODEL` / `PLANNER_RESPONSE` steps.
Orca-managed ACP 1.4.1 transcripts observed locally contain token counts but omit
the model. This patch reads the measured fields without inventing model names or
estimating tokens from text.

AI Vault now reads the total tokens and an explicitly recorded model. Repeated
step indices replace previous usage; cache reads and fresh input are separate
buckets. Thinking is already part of output. The parse-cache version changes so
existing sessions are reparsed once. Parsing works for both local and remote
transcripts. This patch does not add an Antigravity provider to the Stats dashboard
or alter live ACP context-window usage.

## Local report

Use Node 22.18+ (native TypeScript stripping), from the source checkout:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/diagnostics/antigravity/antigravity-usage-report.mjs > /tmp/agy-usage.json
```

Default inputs are the native CLI brain and Orca-managed ACP brain on the current
platform. Override them with repeated `--brain /path/to/brain` arguments. The
report reads transcript files only; it never opens auth files, sends network
requests, or includes prompts, tool arguments, account identifiers, or session IDs
in output. Within a session it prefers `transcript_full.jsonl` over
`transcript.jsonl`; real paths deduplicate repeated roots and symlink aliases.
Independent copied brain stores are separate sources and may overlap.

Limits: 1,000 transcript files, 32 MiB per file and 4 MiB per record. The JSON
includes skipped sessions, malformed/oversized records, unavailable roots and
sessions with measured usage. It is a report of observed usage, not a complete
account history or bill. Older sessions without usage cannot be reconstructed.

## API-equivalent prices

Default Standard text API rates were verified against
https://aistudio.google.com/docs/pricing on 2026-11-16. Antigravity's official
CLI model IDs and effort variants are documented at
https://antigravity.google/docs/cli/headless/.

| Family                  | Input / 1M | Cache read / 1M | Output / 1M | Schedule               |
| ----------------------- | ---------- | --------------- | ----------- | ---------------------- |
| Gemini 4 Hydrogen       | $1.50      | $0.075          | $7.50       | Current published rate |
| Gemini 4 Carbon / Argon | $2.00      | $0.10           | $10.00      | Through 2026-11-30     |
| Gemini 4 Carbon / Argon | $4.00      | $0.20           | $20.00      | From 2026-12-01        |
| Gemini 3.8 Flash        | $0.75      | $0.075          | $3.75       | Through 2026-12-31     |
| Gemini 3.8 Flash        | $1.50      | $0.15           | $7.50       | From 2027-01-01        |

Rates follow each step's timestamp; cutovers use UTC. No timestamp means no
automatic dated price. Effort suffixes map only to supported exact model families.
Unknown model identities, including internal orchestrator/worker IDs, remain
unpriced by default. An orchestrator's routing relationship does not establish
its own standalone API billing rate. No model is inferred for missing metadata.
These are token-only reference estimates; tool fees, cache storage and other
non-token charges are excluded.

Override a model's price with a JSON object keyed by its exact transcript ID and
`inputUsdPerMillion`, `cacheReadUsdPerMillion`, and `outputUsdPerMillion` fields,
all finite nonnegative numbers:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/diagnostics/antigravity/antigravity-usage-report.mjs --prices /path/to/prices.json
```

`pricedSubtotalUsd` sums only priced steps. `measuredUsageEstimateUsd` and each
model's `estimatedUsd` are null if any included step lacks a usable model/rate.
The estimate uses published or explicitly overridden API-equivalent prices; it
is not an Antigravity invoice. Missing models stay unknown even when another step
in the session has a known model.
