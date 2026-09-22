# Codex prompt claims retained after turn completion

Confirmed cancellation keeps a prompt claim until its turn completes. If the prompt's lookup entries are evicted or replaced first, the old `clearTurn()` cannot find it. The separate claims map then retains the prompt until the whole session is cleared.

The fix includes claimed prompts in the existing exact-thread/turn cleanup. Existing turn matching and `forget()` object-identity checks preserve a replacement prompt's authority. Registry limits and cancellation timing are unchanged.

## Source ownership and reachability

1. `codex-structured-provider-events.ts:57` registers incoming prompt requests and publishes them through the translator. `codex-structured-session-acquire.ts:95` binds the translator's turn cleanup to the session registry.
2. `codex-structured-prompt-ownership.ts:33` acquires the claim. Confirmed cancellation deliberately leaves it owned; unsuccessful/unconfirmed cancellation releases it. The actual `CodexStructuredTurnCancellation` invokes the confirmation callback after the injected interrupt transport acknowledges success.
3. `codex-prompt-registry.ts:258` trims the address and journal-binding maps independently. Neither trim removes claims. Replacing the same journal address can similarly leave the old claim without a lookup entry.
4. A later `turn/completed` goes through `translateCodexNotification`, the journal translator and `settleCodexJournalTurn`. Accepted lifecycle settlement invokes `clearPromptTurn` at `codex-structured-journal-settlement.ts:170`.
5. The old cleanup enumerates only address/binding values. The fix also enumerates `claims.keys()`, still filtering by the exact thread/turn. `forget()` deletes replacement lookup entries only when they contain that same prompt object.

The safely expired owner is the claim for the terminal turn whose cleanup has been admitted. Live claims survive unrelated turn cleanup and registry eviction. A refused lifecycle settlement does not clear them.

## Reproduce

From the worktree root, using installed dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/codex-prompt-claim-retention/reproduce.cjs
```

For Electron, use its installed executable with `ELECTRON_RUN_AS_NODE=1`, the same flags and script. The final optional argument selects the report path; the default is `node-results.json` beside the script. No Electron window is created.

`sources.cjs` reverses `fix.patch` against current source and rejects a baseline hash mismatch. It neither reads a previous commit to reconstruct the implementation nor changes product files. The proof bundles actual source in memory. Each report records effective source and bundle hashes, dependency hashes and runtime versions. Only the requested report is written.

The fixture uses the actual registry, server-request delivery, cancellation ownership function, cancellation class, journal translator and delayed notification delivery. It injects an accepting journal sink, interrupt transport and primary-turn lookup. Prompts belong to child threads, so the production child-turn cancellation branch does not enumerate or terminate processes. Every injected process helper throws if unexpectedly called.

The sequence creates 32 ordinary small prompt objects, confirms their cancellations, admits 256 unrelated prompts to evict lookup entries, then completes the original exact turns. WeakRefs count prompt liveness after forced collections. No large payload is attached. The 20-second deadline and 192 MiB heap limit bound the proof.

## Results

Both [Node 26.6.0](./node-results.json) and [Electron 43.7.0 / Node 24.21.0](./electron-results.json) produced:

| Observation                                                                | Before | After |
| -------------------------------------------------------------------------- | -----: | ----: |
| Retained cancelled prompts after lookup eviction, before completion        |     32 |    32 |
| Retained after exact turn completion                                       |     32 |     0 |
| Retained after all lookup maps become empty                                |     32 |     0 |
| Retained after session clear                                               |      0 |     0 |
| Old prompt retained after same-address replacement and old-turn completion |      1 |     0 |

Ordinary completion releases its prompt on both versions. Wrong-thread, wrong-turn and refused-completion controls preserve claims. The replacement prompt and its active claim remain valid after old-turn cleanup on both versions.

The four regression tests cover 32 evicted claims, replacement authority, a compatibility turn digest and session cleanup. Applying the reversed source produces three expected failures; the session-clear control passes. Existing prompt ownership/reply tests also pass on the reversed source. Current source passes 71 tests across six files plus Node, CLI and Web typechecks; [validation.json](./validation.json) records commands and other checks.

## Limits

This is a code-level lifetime defect. The request/completion ordering is deliberately injected; this is not a capture of Codex emitting that sequence or an affected host. Counts do not measure ordinary prompt bytes or establish a growth rate. It does not identify the cause of #19831 or any other incident.

[source-versions.json](./source-versions.json) records matching baseline source at the named main revision. No historical application runtime was reproduced. The fix uses existing turn ownership and identity checks; it adds no arbitrary eviction policy.
