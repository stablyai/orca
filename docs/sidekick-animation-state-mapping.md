# Sidekick animation state mapping

Orca's normalized agent status model has four hook-reported states: `working`, `blocked`, `waiting`, and `done`. `interrupted` is an optional flag on `done`, not a separate failure state.

Codex pet spritesheets can expose more visual rows than Orca has agent states. Sidekick should treat those row names as an asset contract, not as proof that Codex or Orca reports matching runtime states.

The current mapping is:

| Orca condition | Sidekick animation |
| --- | --- |
| Sidekick is being dragged | `jumping` |
| Any fresh agent is `blocked` or `waiting` | `waiting` |
| Any fresh agent is `working` | `running` |
| Any fresh agent is `done` | `review` |
| Any retained completed agent exists | `review` |
| No fresh or retained agent state exists | `idle` |

`SidekickAnimationName` deliberately omits `failed`. Orca distinguishes interrupted completions from normal completions, but interruption can mean user cancellation rather than agent failure, so mapping it to `failed` would overstate the status until Orca has a real failure/error signal. Codex spritesheets may still expose a `failed` row — that row stays as part of the asset contract but is never selected at runtime.
