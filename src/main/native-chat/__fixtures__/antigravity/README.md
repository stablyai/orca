This fixture preserves the record and nested tool-call shapes observed in local
Antigravity CLI transcripts on 2026-09-19. Conversation text, tool arguments,
timestamps, and step numbers are replaced with harmless synthetic values.

A planner step with `status: DONE` can precede a tool step and another planner
response without a new user prompt. It does not prove completion of the user turn.
Tool results use `source: MODEL` and their tool-specific step type; planner tool
calls carry arguments in `args`.
