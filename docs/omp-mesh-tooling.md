# Omp Mesh Tooling

## Problem

`omp` is the assistant runtime the pet binds to (see
[`pet-bound-assistant.md`](./pet-bound-assistant.md)). For the pet to
be useful, omp has to:

- Spawn under the mesh tool config, not omp's bare defaults — without
  this, the spawn has no mesh tool surface and no idea what the mesh
  actually gives it (`88e2e3b2`, also covered in
  `pet-bound-assistant.md`).
- Survive across an app restart, so the operator does not lose the
  thread on a tab close.
- Rotate to a fresh session every 1–3 hours, so context does not
  accrete indefinitely on a small local model.

Two specific plumbing gaps blocked those:

- The injected status extension reported `session_id` / `session_file`
  only for `kind === 'pi'`. `omp` panes never published a resume
  identity, so cold-restore (`--resume`) had no key to bind to.
- omp panes reported `agents: []` until their first prompt, which is
  why the pet binds on tab id rather than agent status — see
  `pet-bound-assistant.md` for that side.

## Goal

- omp is one of `RESUMABLE_TUI_AGENTS` from Orca's perspective, so a
  cold-restore after an app restart resumes the same conversation
  rather than starting fresh.
- omp spawns under the mesh tool config with the same flags
  `spawn_omp_worker.sh` uses, so the pet's assistant sees the same
  tool surface the mesh's own doers see.
- The pet's thread survives a tab close, an app restart, and a 2h
  mark without losing context.

## Non-goals

- Replacing omp's runtime. This arc is plumbing on the Orca side
  only; omp's behaviour is unchanged.
- Adding a new agent type. `RESUMABLE_TUI_AGENTS` already covers the
  category; omp just has to publish the metadata it already has.
- Editing `src/renderer/src/components/pet/pet-agent-spawn.ts`. The spawn flags that make omp durable
  live there; this arc only covers the cold-restore plumbing.
- Changing the rotation cadence. The 1–3h random window is owned by
`src/renderer/src/components/pet/pet-session-epoch.ts`.

## Implementation

### Wire omp into Orca's native agent resume — `448434d3`

Orca already survives agents across a restart — persisted sleeping
records, cold-restore via `--resume` — but only for agents in the
`RESUMABLE_TUI_AGENTS` set, and omp was not one. Two things gated it,
both fixed in this commit:

- **Reporting is ungated for `omp`.** The injected status extension
  reported `session_id` / `session_file` only for `kind === 'pi'`. omp
  is the same `@oh-my-pi` runtime with the same `sessionManager`, so
  the metadata source, the payload line, and the `session_start`
  handler that calls `updateSessionMetadata` are now ungated for
  `omp` too. The cold-restore path that already existed for other
  resume-capable agents now treats omp the same way.
- **Spawn runs under the mesh config.** This is `88e2e3b2`, which is
  the side that makes the cold-restore target actually useful — the
  pet's omp now sees the mesh tool surface (`PET_MESH_CONFIG`,
  `PET_TOOLS`, `PET_PERSONA` in `src/renderer/src/components/pet/pet-agent-spawn.ts`).

### Durable assistant — per-worktree session-dir + --continue — `e40573b8`

Already documented under
[`pet-bound-assistant.md`](./pet-bound-assistant.md#2-durable-assistant--per-worktree-session-dir----continue--e40573b8).
The relevant detail here is that `--continue` rather than `--resume
<id>` is deliberate: resuming by id would need the session uuid,
which lives in a `.jsonl` filename on the worktree's owner host,
which the renderer cannot read (and must not assume is local). With
this commit, the cold-restore key that `448434d3` publishes matches
what `--continue` looks up: the most recent session in the
per-worktree dir.

### Rotate every 1–3h — `0a17cab3`

Already documented under
[`pet-bound-assistant.md`](./pet-bound-assistant.md#3-rotate-the-omp-session-every-13h-for-fresh-context--0a17cab3).
The relevant detail here is that the rotation does not break the
resume plumbing: a fresh spawn drops `--continue` but the dir is
unchanged, so a later resume still finds this fresh thread as the most
recent.

## Combined effect

| Restart boundary              | Pet's assistant survives because                                  |
| ----------------------------- | ---------------------------------------------------------------- |
| Tab close                     | `--session-dir` is per worktree, dir is on the owner host disk   |
| App restart                   | `448434d3` publishes `session_id` / `session_file`; cold-restore resumes via `--continue` |
| 2h mark                       | `0a17cab3` rotated to a fresh session in the same dir, resume still finds it as the most recent |

The three commits are intentionally sequenced: a spawn under the mesh
config without durable session storage would lose the mesh tool
surface on every restart; a durable session without the resume plumbing
would still lose the thread on app restart; a rotation without the
durable dir would orphan the thread.

## Verification

- Unit: `src/renderer/src/components/pet/pet-agent-spawn.test.ts`,
  `src/renderer/src/components/pet/pet-agent-spawn-tokenize.test.ts`
  for the arg builder and `tokenizeStartupCommand` interaction.
- Unit: `src/renderer/src/components/pet/pet-session-epoch.test.ts`
  for the rotation boundary and restart-mid-window persistence.
- Unit: `src/renderer/src/components/pet/pet-bound-session.test.ts`
  for the bind tab workflow.
- Live: spawn a pet assistant, observe `presence.json` and the
  injected status extension publishing `session_id` for the new tab.
  Close the app, restart, observe the cold-restore resuming the same
  session via `--continue`. Wait past the rotation window, observe a
  fresh spawn in the same dir; resume still finds it.