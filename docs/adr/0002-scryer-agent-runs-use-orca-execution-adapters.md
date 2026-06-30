# Scryer agent runs use Orca execution adapters

Scryer agent-run semantics are preserved, but Orca owns Codex/Claude process launch, account state, terminal/runtime state, and UI integration. `ScryerEditSessionController` keeps Scryer model-edit lease and completion-gate workflow over Orca runtime capabilities without duplicating generic agent runtime mechanics.

The edit-session lease token is internal trusted context, not renderer-facing state. Renderer/preload interfaces receive only token-free session status and completion-gate DTOs; `ScryerEditSessionController` resolves any matching token inside the main process before calling the Native Scryer Engine.
