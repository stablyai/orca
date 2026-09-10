# Agent session search: query tuning

What a search costs, and what the knobs in `src/main/ai-vault-search/session-search-engine.ts`
buy. Every number here comes from `config/scripts/session-search-query-benchmark.ts`
over the synthetic corpus in `session-search-synthetic-corpus.ts`, except the
`conversation_fts` shoot-out, which writes its own corpus because the answer
turns on how much of a transcript is tool output. Nothing in this file was
measured against a real transcript, and neither benchmark must ever be pointed
at one.

## Running it

The benchmark is a top-level-await module that imports the main-process tree by
extensionless path, so it needs a bundler-backed runner rather than bare `node`:

```sh
cat > src/main/ai-vault-search/zz-bench.test.ts <<'EOF'
import { it } from 'vitest'
it('runs', { timeout: 1_800_000 }, async () => {
  await import('../../../config/scripts/session-search-query-benchmark')
})
EOF
BENCH_OUT=/tmp/ss-query-bench.json pnpm test src/main/ai-vault-search/zz-bench.test.ts
rm src/main/ai-vault-search/zz-bench.test.ts
```

The `conversation_fts` shoot-out below runs the same way, importing
`config/scripts/session-search-conversation-fts-benchmark` instead, with
`CORPUS_MB` and `TOOL_SHARE` to size and shape its corpus. `config/scripts` is
not inside any typecheck project, so while that throwaway test exists `tsc`
reports TS6307 for each script it pulls in; delete it and the run is clean
again.

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
| `all`          | 6.13 | 8.50 |
| `conversation` | 3.88 | 5.18 |

Per query, `all` then `conversation` (p50 / p95):

| Query | `all` | `conversation` |
| --- | --- | --- |
| `"terminal reattach"` (phrase) | 3.78 / 4.00 | 2.36 / 2.46 |
| `resolveTerminalPath` (identifier) | 6.73 / 6.86 | 4.23 / 4.38 |
| `src/main/…/session-transcript-reader.ts` (path) | 8.35 / 9.88 | 4.29 / 4.42 |
| `why is the daemon snapshot stale` (prose) | 7.27 / 8.20 | 4.98 / 5.37 |
| `reattahc worktre` (typo repair) | 7.42 / 7.82 | 5.07 / 5.18 |
| `index` (common term) | 4.70 / 5.53 | 3.28 / 3.66 |
| `repo:app-3` (operator only) | 0.11 / 0.13 | 0.10 / 0.14 |
| `worktree` scoped to one cwd | 1.34 / 1.40 | 1.02 / 1.06 |

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

## Two FTS tables, or one with a column filter

The stack's open decision 3. `conversation_fts` is a second copy of the two prose
columns, and a column filter over `messages_fts` returns **the identical rowid
set** — checked here per query, not assumed. So the table exists for latency
alone, and this is what that latency is.

Corpus: Claude transcripts written by
`config/scripts/session-search-conversation-fts-benchmark.ts`, 105 MB, indexed
through the real store, at two points in the band a real transcript tree sits in.
Half the tokens in tool output are words the conversation also uses, which is
deliberately generous to the table under question: the more of a query term lives
in `tool_text`, the more the column filter has to read and throw away. Both arms
run the engine's own retrieval SQL, differing only in the table, the BM25 weights
and the `{user_text assistant_text} :` prefix. Twenty queries per route,
interleaved arm by arm, warm cache; two runs.

| Tool share of message text | Route  | `conversation_fts` p50 / p95 | Column-filtered p50 / p95 | Ratio p95 |
| -------------------------- | ------ | ---------------------------- | ------------------------- | --------- |
| 86%                        | phrase | 9.46 / 10.35                 | 11.98 / 12.88             | 1.24      |
| 86%                        | and    | 16.65 / 17.10                | 19.20 / 19.88             | 1.16      |
| 93%                        | phrase | 4.85 / 5.10                  | 6.65 / 6.96               | 1.36      |
| 93%                        | and    | 8.39 / 8.86                  | 10.23 / 10.67             | 1.20      |

The second run agreed on every p50 to within 0.2 ms; its one outlier was a 36 ms
p95 on the `and` route that hit both arms, which is what 20 samples buys.

**Verdict: delete it.** The bar was 2x at p95 on the conversation scope, and the
column filter comes in at 1.16–1.42x across both shares and both runs, while
reading roughly twice the rows to do it (283k unfiltered against 147k filtered on
the phrase route at 86%). Deleting it is a schema bump and a rebuild in PR 2, and
about ten lines here: `ftsTableFor` returns `messages_fts` for both scopes, the
conversation weights become `3.0, 2.0, 0.0, 0.0`, and the expression gains the
column prefix. Nothing else depends on the table.

One number argues the other way and is worth stating rather than burying. PR 2
priced `conversation_fts` at about a quarter of the index, measured on a corpus
whose tool output is 56% of its message text. On a tool-heavy corpus it is **6.7%
of the index at 93% tool output and 11% at 86%**, because `messages_fts` grows
with the tool text and the second table does not. So the saving is smaller than
the decision was framed around, and it is bought with 1.2–1.4x on the latency of
the scope a keystroke uses. The threshold says delete; the numbers for keeping it
are here so that call can be re-made on sight rather than on memory.

## `sessionCandidateLimit`

The reviewer's F13: this is a tunable default, not a constant. It bounds how many
sessions the SQL hands ranking, so it bounds both retrieval cost and how deep a
caller can page before the answer simply stops.

The limit only costs anything once more sessions match than the limit allows, so
this is measured over a second corpus: 2,500 one-turn transcripts, 10.9 MB, every
one of them matching the query. Limits are interleaved sample by sample, because
run back to back the first configuration pays for every page the OS cache had not
seen and the ordering alone moves p95 further than the limit does.

| Limit | p50 | p95 | Pages of 20 a caller can reach |
| --- | --- | --- | --- |
| 200 | 5.82 | 6.12 | 10 |
| 600 | 6.92 | 7.39 | 30 |
| 1200 | 8.43 | 9.18 | 60 |
| 2400 | 11.30 | 12.18 | 120 |

600 is the default: it costs about 19% over 200 at p50 and buys three times the
reachable depth, and the curve only turns steep past 1200. A host with a much
larger index can raise it; the result's `truncated.candidates` says when the limit
was the thing that cut the answer, so a caller never has to guess.

What is **not** measured here is relevance. These numbers say what a limit costs,
not what it retrieves. The MRR figures quoted in the BM25 weights
(`session-search-retrieval.ts`) and in the identifier shadow column
(`session-search-identifier-split.ts`) come from the original retrieval shoot-out
on real transcripts and are not reproducible from this repository. Any change to
the limit justified on relevance grounds needs an eval set, not this benchmark.

## Page warmup, dropped

PR 2 deferred `warm()` — a sliced read of `messages` that pulls its pages into
the OS cache before the first query — to whoever knew which pages a read
touches. It is not re-added here, for two reasons. The measurement that
justified it (first query 1.3 s to 0.45 s) was on a 4 GB index, and neither
corpus in this file is within an order of magnitude of that, so PR 4 cannot
show a win: removing the call moved the 10.5 MB corpus's p50 by less than the
run-to-run spread. And it is a cancellable background pass, which needs an owner
with a lifecycle; a query library that holds no timers has nothing to hang the
`stopped()` on, and a fire-and-forget async read from a synchronous `search` is
a rejection nothing can supervise. It belongs with the indexer in PR 3b, which
already owns starting and stopping work.

## Not settled here

Which process may open, unlink and rebuild the index is PR 3b's decision. A
second handle that finds an older schema version replaces the file while a live
store keeps answering from the unlinked inode, and this PR is what first makes
that reachable, because it is the first thing that reads. What PR 4 does is
refuse to make it worse. The engine carries its own schema — the vocabulary, the
query log and the generation triggers — and re-creates whatever of it is missing
on every search, so a dropped object heals rather than degrading. The one it
cannot re-create is the vocabulary's source, because `messages_fts` is the
store's; an index in the middle of a rebuild is named as unable to serve typo
repair and still answers from the conversation table, rather than throwing on
the first query that reaches for one.
