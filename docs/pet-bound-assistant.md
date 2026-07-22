# Pet Bound Assistant

## Problem

The pet needs an assistant it can talk to without the operator having to
find one first. The first attempts surfaced three sharp bugs:

- **No assistant is askable after a spawn.** `omp` panes publish
  `agents: []` until their first prompt. Anything that waits for
  `AgentStatusEntry` to populate before letting the pet ask is the wrong
  shape — the pet spawns an assistant, then still has nothing to say to
  it.
- **The thread dies with the tab.** The pet's binding was a per-tab
  record, so an app restart lost the assistant's whole conversation.
- **Tool approvals were silent.** `--approval-mode always-ask` blocks
  `omp` between `tool_call` and `tool_execution_start`, but the status
  extension subscribed to neither approval event, so Orca never left the
  preceding "working" state. The tool sat gated behind a normal spinner
  with no signal to the user.

Without a fix, the right-click → "Give me an assistant" flow was
indistinguishable from a click that did nothing, and even when the
binding worked the assistant's context only ever grew on a small local
model.

## Goal

- The pet is always askable after a spawn, regardless of agent status.
- The assistant's thread survives a tab close and an app restart.
- Tool approvals are surfaced on the pet as a real state, not a spinner.
- The session rotates to a fresh one every 1–3 hours so context does
  not accrete indefinitely.
- The assistant runs under the mesh tool config, not omp's bare defaults.

## Non-goals

- Changing the agent's model. `PET_OMP_MODEL` (`mesh-litellm/LFM2.5-8B-A1B-Q4_0.gguf`)
  is the mesh's standing decision recorded in meshina's `plans/HANDOFF.md`:
  ties gemma-4-12B on latency, wins on context (128K), and is already the
  voice arm so speak-back and the pet answer from one model. Never cloud,
  never Ternary-Bonsai (64–76s, depth-only).
- Replacing `--approval-mode always-ask`. The pet can open SSH endpoints
  and browser panels, so it is a real actor and every action should be
  confirmable.
- Adding a status bar / chrome control for the binding. The binding is a
per-pet record (`src/renderer/src/components/pet/pet-bound-session.ts`), not a global setting.
- Changing `--mode rpc`. The spawn is still a visible pane so it earns
  free agent status via the `ORCA_PANE_KEY`-gated status extension.

## Implementation

The bound assistant arc is split across six commits on
`feat/pet-full-port`. Each one solves one of the bugs above.

### 1. Bind the spawned assistant so the pet is always askable — `e6006c19`

`src/renderer/src/components/pet/pet-agent-spawn.ts:135` (`usePetAgentSpawn`)
calls `launchAgentInNewTab(...)`, and on a successful spawn immediately
calls `setPetBoundSession({ tabId: result.tabId, worktreeId })` from
`src/renderer/src/components/pet/pet-bound-session.ts`. The bind happens
on the tab we just created, not on agent status — that is what makes the
pet askable before the first prompt. The comment in the code captures
the reasoning: an omp pane reports `agents: []` until its first prompt,
so a pet that waited for status would spawn an assistant and then still
have nothing to say to it.

### 2. Durable assistant — per-worktree session-dir + --continue — `e40573b8`

The spawn args in `src/renderer/src/components/pet/pet-agent-spawn.ts:98`
(`buildPetOmpAgentArgs`) hand omp two flags that make the thread
survive:

- `--session-dir $HOME/.local/state/meshina/omp-sessions/<safe-name>`
  where `<safe-name>` is `petSessionDirName(worktreeId)` from the same
  file (`pet-agent-spawn.ts:62`) — keyed by worktree, sanitized to
  `[A-Za-z0-9._-]`, with a short hash suffix so two worktrees that
  sanitize alike do not collide.
- `--continue` to resume the most recent session in that dir. `--continue`
  rather than `--resume <id>` is deliberate: resuming by id would need
  the session uuid, which lives in a `.jsonl` filename on the worktree's
  owner host, which the renderer cannot read.

`$HOME` is left literal in both the session root and the mesh config
path because the startup command runs in the pty's shell on the worktree's
owner host, which is also the only host that can resolve `$HOME`
correctly for an SSH/remote worktree.

### 3. Rotate the omp session every 1–3h for fresh context — `0a17cab3`

`pet-agent-spawn.ts:141` calls `resolveSpawnFreshness(...)` from
`src/renderer/src/components/pet/pet-session-epoch.ts` before spawning.
A fresh spawn drops `--continue` so omp starts a new session in the same
dir; a later resume still finds this fresh thread as the most recent.

The threshold is drawn randomly in `[1h, 3h]` per epoch rather than a
fixed 2h so rotations do not land on a predictable boundary ("every
1–3 hours" literally), and it is persisted per session-dir so a restart
mid-window does not reset the clock.

### 4. Surface omp tool approvals as a sticky waiting state — `2484e842`

`omp` emits `tool_approval_requested` / `tool_approval_resolved`
(confirmed in its bundle: the runner only prompts when a handler is
registered for them). The injected status extension now posts both, and
the hook listener maps `requested` → a sticky "waiting for approval"
state on the pet's status. Orca therefore leaves the preceding
"working" state instead of letting the tool sit gated behind a normal
spinner. This is the fix that made approvals visible on the pet overlay
at all.

### 5. Spawn omp under the mesh tool config, not bare defaults — `88e2e3b2`

`pet-agent-spawn.ts:32` (`PET_MESH_CONFIG`) loads
`$HOME/meshina/configs/omp/mesh-coding.yml` exactly as
`scripts/mesh/spawn_omp_worker.sh` does — model roles, web provider,
approval posture. Without it the pet spawns on omp's bare defaults:
no mesh tool surface and no idea what the mesh gives it. With it, omp
sees the same lean coding core + web tool set the mesh's own doers use
(`PET_TOOLS = 'read,bash,edit,write,grep,glob,todo,web_search'` at
`pet-agent-spawn.ts:38`), and `PET_PERSONA` (same file, lines 45–52)
tells it how to reach the mesh's actual web tools — SearXNG on
node-d:8080 via `scripts/mesh/searxng_search.sh`, CloakBrowser CDP on
node-b:9222. The persona is single-quoted so `tokenizeStartupCommand`
in Orca keeps it as one shell token rather than shattering on spaces.

### 6. Right-click jump / ask + always-visible menu + empty-state offer

- `5899b631` — `src/renderer/src/components/pet/pet-agent-jump.ts` resolves which agent matters using
  the same `selectPetBubbleWinner` rule the bubble already computes;
  right-click → "go to that agent" navigates to its pane.
- `1a072a45` — `src/renderer/src/components/pet/pet-agent-ask.ts` reuses that same target so the ask
  runs against the same agent the jump would land on, with no second
  rule to drift.
- `301db8b2` — the right-click menu is always visible. The previous
  behaviour omitted the menu when no agent had reported, which was
  reported as "right click is not working" against a build where it
  worked exactly as designed.
- `11757974` — the empty state is an offer ("Give me an assistant")
  rather than a disabled row, so a user with a pet up and no agent
  reports lands in the natural next step instead of an apology.

## Verification

- `src/renderer/src/components/pet/pet-agent-spawn.test.ts`, `src/renderer/src/components/pet/pet-agent-spawn-tokenize.test.ts` for the

- `src/renderer/src/components/pet/pet-session-epoch.test.ts` for the 1–3h rotation boundary and
  restart-mid-window persistence.
- `src/renderer/src/components/pet/pet-bound-session.test.ts` for the bind tab workflow.
- `src/renderer/src/components/pet/pet-agent-ask.test.ts`, `src/renderer/src/components/pet/pet-agent-jump.test.ts` for the right-click
  rows.
- `src/renderer/src/components/pet/pet-agent-state.test.ts` for the approval state surface.

Smoke: real omp accepts every flag in `buildPetOmpAgentArgs` and reports
`read, bash, edit, write, grep, web_search, orca-cli, orca-per-workspace-env`;
the model lists them when asked, so it knows what it holds. The
completion → speak path and the durable session → restart-resume path
are also smoke-tested against the live node-b / node-a mesh.