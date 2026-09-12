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
| `all`          | 7.22 | 8.94 |
| `conversation` | 5.33 | 7.86 |

Per query, `all` then `conversation` (p50 / p95):

| Query                                            | `all`        | `conversation` |
| ------------------------------------------------ | ------------ | -------------- |
| `"terminal reattach"` (phrase)                   | 5.24 / 8.42  | 2.97 / 3.24    |
| `resolveTerminalPath` (identifier)               | 7.55 / 8.94  | 6.47 / 6.72    |
| `src/main/…/session-transcript-reader.ts` (path) | 8.69 / 10.12 | 7.78 / 8.04    |
| `why is the daemon snapshot stale` (prose)       | 7.84 / 8.57  | 5.90 / 7.01    |
| `reattahc worktre` (typo repair)                 | 7.30 / 7.39  | 5.53 / 5.89    |
| `index` (common term)                            | 5.45 / 5.66  | 3.81 / 4.02    |
| `repo:app-3` (operator only)                     | 0.12 / 0.16  | 0.10 / 0.10    |
| `worktree` scoped to one cwd                     | 1.47 / 1.63  | 1.25 / 1.49    |

Reading it:

- `conversation` is about 1.4x faster at p50 and 1.1x at p95, and it is a column
  filter over the same table rather than a table of its own. Narrowing to the
  two prose columns is what buys the gap: fewer postings to score. It is also
  the scope where a match is something a person wrote rather than something a
  tool printed.
- A `scopePaths` query is the cheapest real search on the page. It is the one
  narrowing SQL can express exactly, so it seeks `sessions_cwd_key` and hands
  ranking a small candidate set.
- The operator-only figure is a floor, not a typical cost. `repo:` and `path:`
  are applied in JS over retrieved rows (see `session-search-row-filter` for why
  they cannot be pushed into SQL), so their cost tracks how many sessions the
  walk has to read before it fills a candidate set. This corpus has 40 sessions,
  which is one page of that walk; an index where few sessions match the operator
  will read up to the ceiling in `session-search-retrieval` instead.

## What the conversation scope costs at real corpus size

`conversation` was a second FTS table holding a copy of the two prose columns.
It is a column filter now — `{user_text assistant_text}: (…)` with bm25 weights
that zero the other two — and PR 2 deleted the table on the strength of the
shoot-out this section used to hold: the filter came in at 1.16-1.36x the p95 of
the dedicated table, under the 2x bar, while the table cost a tenth of the index
to maintain. What follows is what the shipped schema actually does, measured
again on the same corpus after the table went and tool rows were capped.

Corpus: Claude transcripts from `config/scripts/session-search-tool-heavy-corpus.ts`,
105 MB, indexed through the real store, at two points in the 80-97% band a real
transcript tree sits in. Half the tokens in tool output are words the
conversation also uses, so a conversation term really does have postings the
filter must discard. Twenty queries per rung, both scopes interleaved query by
query, warm cache; `config/scripts/session-search-scope-benchmark.ts`, run twice.

| Tool share | Rung   | `all` p50 / p95 | `conversation` p50 / p95 |
| ---------- | ------ | --------------- | ------------------------ |
| 86%        | phrase | 16.69 / 17.48   | 13.08 / 13.52            |
| 86%        | or     | 31.91 / 35.74   | 22.25 / 23.87            |
| 86%        | and    | 70.04 / 74.00   | 53.47 / 59.39            |
| 93%        | phrase | 9.14 / 13.36    | 7.23 / 8.51              |
| 93%        | or     | 16.46 / 18.70   | 12.34 / 14.88            |
| 93%        | and    | 39.65 / 43.44   | 31.05 / 32.92            |

Three things to read out of it.

**The filter is a win, not a cost.** Every rung is faster narrow than wide, by
1.2x to 1.4x at p50. The shoot-out compared the filter against a table built for
exactly this query; against the wide table it replaces, it does what the second
table did, which is read fewer postings.

**The `and` rung is where the corpus size shows.** Those queries are eight terms,
chosen so no ordered run that long occurs and the phrase rung has to miss; a
real two-term AND sits nearer the phrase row. It is also the noisiest: the
second run's p95 reached 140 ms on one bucket, which is what twenty samples of a
70 ms query buys. Read the p50 column.

**The index is far smaller than the shoot-out's was.** 57 MB at 93% tool output
and 103 MB at 86%, against roughly 150 MB for `messages_fts` alone before PR 2
capped an indexed tool row at 3,072 characters. Most of a tool-heavy transcript
is now not in the index at all, which moves every number above and is the larger
effect of the two.

What is **not** measured here is relevance, and the column filter does carry one
ranking difference the deleted table did not. FTS5's bm25 normalises by the
whole row's length and has no per-column length, so two rows with identical
prose score differently when one also holds tool output. The rowid set is
unchanged, which is what the deletion was decided on; the order within it can
move. `session-search-engine.test.ts` pins the direction.

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
| 200   | 6.85  | 7.21  | 10                             |
| 600   | 7.93  | 8.36  | 30                             |
| 1200  | 9.55  | 10.53 | 60                             |
| 2400  | 12.32 | 13.45 | 120                            |

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

## What typo repair costs

The repair is the one rung whose cost tracks the size of the vocabulary rather
than the size of a result. It only runs for a term the scope has no posting for,
so an ordinary query never pays it; a query of nonsense pays it once per term.

Measured over a synthetic vocabulary of 1.6 M distinct terms, every term in two
rows so none is filtered out:

| Query                                  | p50    |
| -------------------------------------- | ------ |
| one known term (no repair)             | 11 ms  |
| one unknown term                       | 10 ms  |
| 39 unknown 12-character terms (480 ch) | 387 ms |
| 12 unknown 40-character terms          | 99 ms  |

Two things follow. The cost is linear in unknown terms and in vocabulary size,
and `search` is synchronous, so a 512-character query of nonsense holds the
thread for a third of a second on an index that large. And the scoped-count fix
made this cheaper rather than dearer — it was 737 ms before — because ordering
the vocabulary scan by term drops the sort that ordering by `doc` required, and
the counts it added are at most eight bounded probes per prefix. A cap on
unknown terms per query is recorded as a follow-up in the split plan.

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
refuse to make it worse. The engine restores its derived vocabulary and generation
triggers before a search. A missing `messages_fts` fails clearly; the connection
owner must rebuild the source index. There is no degraded-search capability state
or query logging. Logging can be added by a caller when an evaluation consumer exists.

Each search checks the generation before retrieval and after its final content
read. A concurrent commit rejects the page with `stale-generation`, including a
first page without a cursor. The caller can retry from page one. No long-lived
read transaction is needed, and a mixed page is never returned as a valid snapshot.

Repository/path operators are applied before a phrase or AND route is accepted.
Candidate truncation remains explicit, including when an earlier route reached
its cap but had no eligible sessions.
