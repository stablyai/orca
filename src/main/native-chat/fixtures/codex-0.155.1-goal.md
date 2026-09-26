Captured locally from Codex CLI 0.155.1 on 2026-09-22 using an isolated app-server
home and `thread/start`, then `thread/goal/set`. No credentials were copied.
The goal event really occupied physical line 3 (ordinal 2). The provider also
wrote the goal-context response item. Session ids and paths were sanitized;
metadata/settings were reduced to relevant fields. The final assistant item is
an explicitly synthetic sentinel added to exercise ordering, not a paid model
response. The issue is https://github.com/stablyai/orca/issues/22169.

The capture independently reproduces the shape described by OrcaWin's earlier
https://github.com/stablyai/orca/pull/13985; no code or fixture was copied from it.
