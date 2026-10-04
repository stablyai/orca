This fixture preserves the record and nested tool-call shapes observed in local
Antigravity CLI transcripts on 2026-09-19. Conversation text, tool arguments,
timestamps, and step numbers are replaced with harmless synthetic values.

A planner step with `status: DONE` can precede a tool step and another planner
response without a new user prompt. It does not prove completion of the user turn.
Tool results use `source: MODEL` and their tool-specific step type; planner tool
calls carry arguments in `args`.

`live-timestamp-tie.jsonl` preserves two actual macOS agy 1.2.14 records from
2026-10-02, produced by an authenticated Claude Sonnet Chat-composer turn in a
disposable folder. User step 9 and assistant step 10 have the same second-level
`created_at`. Their IDs and timestamps are retained to reproduce reply-before-user
lexical sorting; the optional provider step order fixes it without changing either.
Account identifiers, native username and task-profile suffix are scrubbed if present.
No synthesized model output is used in this capture.
