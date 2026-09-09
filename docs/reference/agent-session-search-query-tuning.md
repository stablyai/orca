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
cache, machine otherwise idle. Milliseconds, and p95 over 25 samples moves
several milliseconds run to run if anything else is competing for the disk.

| Scope          | p50  | p95  |
| -------------- | ---- | ---- |
| `all`          | 6.08 | 8.82 |
| `conversation` | 3.74 | 5.09 |

Per query, `all` then `conversation` (p50 / p95):

| Query                                            | `all`       | `conversation` |
| ------------------------------------------------ | ----------- | -------------- |
| `"terminal reattach"` (phrase)                    | 3.61 / 3.76 | 1.94 / 2.09    |
| `resolveTerminalPath` (identifier)                | 6.16 / 6.40 | 3.81 / 3.97    |
| `src/main/…/session-transcript-reader.ts` (path)  | 8.76 / 11.14| 3.95 / 3.98    |
| `why is the daemon snapshot stale` (prose)        | 7.61 / 7.81 | 5.07 / 5.19    |
| `reattahc worktre` (typo repair)                  | 7.32 / 7.51 | 4.93 / 5.09    |
| `index` (common term)                             | 5.34 / 5.58 | 3.54 / 3.61    |
| `repo:app-3` (operator only)                      | 0.13 / 0.16 | 0.12 / 0.13    |
| `worktree` scoped to one cwd                      | 1.48 / 1.52 | 1.05 / 1.13    |

Reading it:

- `conversation` is about 1.6x faster at p50 and 1.7x at p95. That gap is the
  answer to "what is the second table for": it is the corpus a keystroke can
  afford, and it holds no tool output, so it is also the corpus where a match is
  something a person wrote.
- A `scopePaths` query is the cheapest real search on the page. It is the one
  narrowing SQL can express exactly, so it seeks `sessions_cwd_key` and hands
  ranking a small candidate set.
- The operator-only figure is a floor, not a typical cost. `repo:` and `path:`
  are applied in JS over retrieved rows (see `session-search-row-filter` for why
  they cannot be pushed into SQL), so their cost tracks how many sessions the
  walk has to read before it fills a candidate set. This corpus has 40 sessions,
  which is one page of that walk; an index where few sessions match the operator
  will read up to the ceiling in `session-search-retrieval` instead.

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
| 200   | 7.08  | 7.23  | 10                             |
| 600   | 8.18  | 8.73  | 30                             |
| 1200  | 9.72  | 10.44 | 60                             |
| 2400  | 12.60 | 13.68 | 120                            |

600 is the default: it costs about 16% over 200 at p50 and buys three times the
reachable depth, and the curve only turns steep past 1200. A host with a much
larger index can raise it; the result's `truncated.candidates` says when the limit
was the thing that cut the answer, so a caller never has to guess.

What is **not** measured here is relevance. These numbers say what a limit costs,
not what it retrieves. The MRR figures quoted in the BM25 weights
(`session-search-retrieval.ts`) and in the identifier shadow column
(`session-search-identifier-split.ts`) come from the original retrieval shoot-out
on real transcripts and are not reproducible from this repository. Any change to
the limit justified on relevance grounds needs an eval set, not this benchmark.

## Not settled here

Which process may open, unlink and rebuild the index is PR 3b's decision. A
second handle that finds an older schema version replaces the file while a live
store keeps answering from the unlinked inode, and this PR is what first makes
that reachable, because it is the first thing that reads. What PR 4 does is
refuse to make it worse: an engine over an index it does not fully recognise
answers from the tables that are there and names the feature it cannot serve,
rather than throwing on the first query that reaches for one.
