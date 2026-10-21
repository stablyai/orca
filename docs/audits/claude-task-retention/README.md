# Retained Claude background-task text

The actual Claude task tracker retained oversized input strings through its
512-character description/name slices. Its live tasks, settled tasks, and
recently removed tasks can each retain those slices. The fix uses the existing
`ownRetainedString` at the shared text boundary; normalization, UTF-16 clipping,
task identity, publication, and lifecycle behavior stay the same.

This extends [ML-018 / #20960](https://github.com/stablyai/orca/pull/20960).

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/claude-task-retention/reproduce.cjs
```

The script bundles the actual tracker and its retention classes. Its baseline
removes only the new copy call in memory. It exercises flat strings, concatenated
strings, and JSON-parsed SDK-style frames; each input has a distinct task owner.
It measures after GC, then clears the tracker and yields before measuring cleanup.
[Results and bundle hashes](./results.json) preserve the complete run.

| JSON-parsed case          |   Input per task | Tasks |      Visible text | Heap before | Heap after |
| ------------------------- | ---------------: | ----: | ----------------: | ----------: | ---------: |
| Live                      | 64 Ki characters |    32 | 16,384 characters |   2,125,672 |     43,536 |
| Settled                   | 64 Ki characters |    32 | 16,384 characters |   2,127,072 |     44,296 |
| Removed, awaiting outcome | 64 Ki characters |    32 |      0 characters |   2,108,136 |     25,360 |
| Live                      |  4 Mi characters |     8 |  4,096 characters |  33,562,624 |     11,048 |
| Settled                   |  4 Mi characters |     8 |  4,096 characters |  33,563,960 |     11,656 |
| Removed, awaiting outcome |  4 Mi characters |     8 |      0 characters |  33,558,584 |      7,008 |

Captured with Node v26.6.0 on macOS. Cleanup returned near the initial heap for
every case. Six regression tests retain the actual tracker through these three
lifetimes for both descriptions and names. Text behavior tests preserve whitespace
normalization, fallback names, and a clipped surrogate pair.

## Reachability and limits

`claude-stream-json-connection.ts` forwards SDK messages to the structured adapter,
whose `emit` calls `backgroundTasks.observe`. Installed SDK 0.3.251 uses Node
`readline` to assemble stdout records, parses each record with `JSON.parse`, then
yields it. The inspected path imposes no record or description length limit;
native read-chunk size does not cap an assembled JSON field. Descriptions are
declared as plain strings in `SDKTaskStartedMessage`.

The description slice and this SDK version also exist in `v1.4.198`; that tag
keeps the reader inline in `claude-background-task-tracker.ts`. The separate
settled/recently-removed retention and name-reader paths describe current code.

The current maps are count-bounded: at most 256 live, 256 settled, and 256 recently
removed entries per tracker. Settled context clears when no visible work remains;
recently removed context awaits an outcome, eviction, or explicit clearing.
Session end/close clears the tracker. Copy work is at most 512 UTF-16 code units
per retained field, and it does not reduce temporary parsing allocation.

These are synthetic oversized task fields, not evidence that an affected user
received such fields. The path concerns structured Claude sessions, not ordinary
terminal output or stderr. Neither #19831 nor #19768 establishes this trigger.

The separate digest-bounded subagent ID was also checked at actual consumers.
The mobile response sanitizer can temporarily retain the original until JSON
serialization flattens its concatenated ID. Worker transcript bounding already
serializes for its byte budget and released that parent in the probe. No durable
ID-owner leak was established, so that helper is unchanged.
