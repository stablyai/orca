# Agent session search: query tuning

What a search costs, and what the knobs in `src/main/ai-vault-search/session-search-engine.ts`
buy. Every number here comes from `config/scripts/session-search-query-benchmark.ts`
over the synthetic corpus in `session-search-synthetic-corpus.ts`. Nothing in this
file was measured against a real transcript, and the benchmark must never be
pointed at one.

## Running it

The benchmark is a top-level-await module that imports the main-process tree by
extensionless path, so it needs a bundler-backed runner rather than bare `node`:

```sh
cat > src/main/ai-vault-search/zz-bench.test.ts <<'EOF'
import { it } from 'vitest'
it('runs', { timeout: 600_000 }, async () => {
  await import('../../../config/scripts/session-search-query-benchmark')
})
EOF
BENCH_OUT=/tmp/ss-query-bench.json pnpm test src/main/ai-vault-search/zz-bench.test.ts
rm src/main/ai-vault-search/zz-bench.test.ts
```

`BENCH_OUT` exists because vitest intercepts `console.log`; the report is written
to that path as well as printed.

## Scope: what the second FTS table buys a reader

Corpus: 40 synthetic Claude transcripts, 10.5 MB, 9,600 messages, indexed through
the real store. Eight queries, one per rung of the route ladder plus the two
shapes that skip it; 5 warm-up runs and 25 samples each. Apple silicon, warm page
cache. Milliseconds.

| Scope          | p50  | p95   |
| -------------- | ---- | ----- |
| `all`          | 8.46 | 41.74 |
| `conversation` | 5.32 | 12.20 |

Per query, `all` then `conversation` (p50 / p95):

| Query                                            | `all`         | `conversation` |
| ------------------------------------------------ | ------------- | -------------- |
| `"terminal reattach"` (phrase)                    | 5.03 / 5.86   | 2.77 / 3.78    |
| `resolveTerminalPath` (identifier)                | 8.47 / 9.54   | 5.39 / 17.89   |
| `src/main/…/session-transcript-reader.ts` (path)  | 11.96 / 39.31 | 5.55 / 17.27   |
| `why is the daemon snapshot stale` (prose)        | 10.78 / 25.23 | 7.11 / 12.34   |
| `reattahc worktre` (typo repair)                  | 10.41 / 115.05| 6.73 / 9.41    |
| `index` (common term)                             | 7.25 / 29.99  | 4.98 / 11.51   |
| `repo:app-3` (operator only)                      | 0.10 / 0.60   | 0.10 / 0.20    |
| `worktree` scoped to one cwd                      | 2.10 / 2.60   | 1.48 / 2.06    |

Reading it:

- `conversation` is about 1.6x faster at p50 and 3.4x at p95. That gap is the
  answer to "what is the second table for": it is the corpus a keystroke can
  afford, and it holds no tool output, so it is also the corpus where a match is
  something a person wrote.
- An operator-only query never touches FTS at all. It is a range seek on
  `sessions_cwd_key`, and it costs a tenth of a millisecond.
- Typo repair's p95 in `all` is the worst number on the page. The repair walks
  `messages_vocab` per prefix, and the first walk after a cold statement cache
  pays for the b-tree pages. It is a first-query cost, not a per-query one.

## `sessionCandidateLimit`

The reviewer's F13: this is a tunable default, not a constant. It bounds how many
sessions the SQL hands ranking, so it bounds both retrieval cost and how deep a
caller can page before the answer simply stops.

The limit only costs anything once more sessions match than the limit allows, so
this is measured over a second corpus: 2,500 one-turn transcripts, 10.9 MB, every
one of them matching the query. Limits are interleaved sample by sample, because
run back to back the first configuration pays for every page the OS cache had not
seen and the ordering alone moves p95 further than the limit does.

| Limit | p50   | p95   | Pages of 20 a caller can reach |
| ----- | ----- | ----- | ------------------------------ |
| 200   | 9.50  | 13.18 | 10                             |
| 600   | 10.86 | 20.30 | 30                             |
| 1200  | 12.65 | 15.20 | 60                             |
| 2400  | 17.68 | 27.08 | 120                            |

600 is the default: it costs about 14% over 200 at p50 and buys three times the
reachable depth, and the curve only turns steep past 1200. A host with a much
larger index can raise it; the result's `truncated.candidates` says when the limit
was the thing that cut the answer, so a caller never has to guess.

What is **not** measured here is relevance. These numbers say what a limit costs,
not what it retrieves. The MRR figures quoted in the BM25 weights
(`session-search-retrieval.ts`) and in the identifier shadow column
(`session-search-identifier-split.ts`) come from the original retrieval shoot-out
on real transcripts and are not reproducible from this repository. Any change to
the limit justified on relevance grounds needs an eval set, not this benchmark.
