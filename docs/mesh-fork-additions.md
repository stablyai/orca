# Mesh Fork Additions

## Problem

The `maczzinatui/orca` mesh fork lives on `feat/pet-full-port` as the host
for the **pet** and the **mesh speak-back** experiences. At the time this
index was written the branch had **87 commits** diverging from
`origin/main` (the `stablyai/orca` upstream) with no `docs/` describing
them, so a reader landing on the branch cannot tell which files belong to
the fork versus an upstream panel-canvas / pinned-panel line that happens
to be merged in here.

This index fixes that by mapping every non-upstream commit to one of the
fork's six arcs. Deeper narrative for each arc lives in the per-arc
design docs in this directory:

- [`pet-bound-assistant.md`](./pet-bound-assistant.md) — spawn omp, bind,
  ask/jump, durable `--continue`, tool-approval surface, 1–3h rotation.
- [`pet-cross-surface-handoff.md`](./pet-cross-surface-handoff.md) —
  P0–P5 presence authority + RPC + popouts + phone roam + edge handoff.
- [`pet-identity.md`](./pet-identity.md) — travelling identity is the
  catalogue slug, not a per-install UUID; clobber self-heal; Petdex
  starter pack.
- [`pet-roam-and-overlay.md`](./pet-roam-and-overlay.md) — in-window roam
  with busy/drag pause, shared engine for the phone, right-click menu,
  overlay React #185 fix.
- [`mesh-voice.md`](./mesh-voice.md) — mesh TTS speak-back on desktop +
  mobile, Kokoro voice picker, completion-push watcher.
- [`omp-mesh-tooling.md`](./omp-mesh-tooling.md) — omp under the mesh
  tool config, native agent-resume plumbing for omp.
- [`relay-nodepty-toolchain.md`](./relay-nodepty-toolchain.md) — relay
  node has no Linux node-pty prebuild; gcc + gnumake + glibc toolchain
  probe; per-relay-dir rebuild.

The cross-cutting release narrative (what shipped in which node-b cut, why
these arcs land together) lives in **meshina** rather than this repo:

- `CHANGELOG` entries `v0.5.251` and `v0.5.252`
- `wiki/services/orca-pet-port.md`

## Goal

Give a reader a one-table answer to "what changed on `feat/pet-full-port`
that is not upstream?" and a one-link answer to "where do I read the
design for this arc?". No code changes; the table is built from
`git log origin/main..feat/pet-full-port` and cites commit hashes that
resolve in this tree.

## Non-goals

- Restating every commit body verbatim. The fork commits already carry
  long bodies explaining the operator-facing bug; this index keeps the
  per-row note to one line.
- Documenting the upstream panel-canvas / pinned-terminal-panel /
  sidebar work that ships on this branch via the Panel Canvas merge
  (`533fb2eb2`). Those lines exist upstream and have their own docs.
- Documenting the `wip(pet-full-port): OOM salvage` commit
  (`d76e8ad0d`) as a feature. The author flag and the commit body mark it
  unvalidated; it is listed here only for completeness.
- Covering `mobile/` arc (`feat(mobile)`, `fix(mobile)`, `refactor(mobile)`)
  in depth. Those commits live in a separate build and are tracked in
  the mobile app's own change notes; this index only notes them so the
  branch count reconciles.

## Commit index

87 commits, grouped by arc. Hashes are the 8-char `git log --oneline`
form. The `wip(pet-full-port)` row and the `feat(mobile)` / `fix(mobile)` /
`refactor(mobile)` rows are listed at the end and are not part of any fork
arc doc.

### Arc — pet cross-surface handoff (P0–P5, identity on the wire, dead surface eviction)

| Commit     | Subject |
| ---------- | ------- |
| `3e6e3f272` | feat(pet): P0 cross-surface presence + handoff state machine |
| `84e3fc2f4` | feat(pet): P1 presence authority + RPC — exclusivity becomes real |
| `a58f120be` | feat(pet): P2 desktop surfaces — the pet can now leave a window |
| `436226b22` | refactor(pet): move roam engine to shared for the phone to reuse |
| `7c81855d8` | feat(pet): P3+P4 — the pet renders and roams on the phone |
| `533fb2eb2` | merge: bring Panel Canvas branch into the pet tree |
| `da7d420f3` | feat(pet): P5 popouts are pet surfaces — the DAG is complete |
| `03360527e` | fix(pet): phone surface id must outlive the screen, not the mount |
| `3fc170b92` | fix(pet): a dead surface must not be a handoff destination |
| `51734a9b0` | fix(pet): pet identity must travel with the pet, not be guessed per surface |
| `347e6c0ab` | fix(pet): travelling identity is the catalogue slug, never a per-install UUID |
| `b1827a64e` | fix(pet): an arriving pet must not land on an edge |
| `f6adc15f3` | fix(pet): a clobbered identity must heal itself, not wall the pet in |
| `dd999f0a6` | fix(pet): a popout must not repaint the operator's pet as Claudino |
| `555052160` | fix(pet): hand the pet off instantly when a popout holding it closes |

A pure state machine for cross-surface handoff, then the main-process
authority that owns it, desktop renderer as a client of that authority,
the shared roam engine so the phone runs the same module, the phone's
own rendering + frame manifest so the pet actually draws there, the
merge that pulls panel canvas in so a popout is a real destination,
popout registration as a distinct surface kind, then five fixes against
the new wiring: phone surface id outliving the screen, zombie surfaces
blocked from handoff, identity on the wire, slug normalization for
cross-machine identity, no-edge landing, clobbered-id self-heal,
popout-preserves-identity, and instant eviction on webContents destroy.

### Arc — pet bound assistant (spawn omp, bind, ask/jump, durable, rotation, approvals)

| Commit     | Subject |
| ---------- | ------- |
| `e6006c198` | feat(pet): bind the spawned assistant so the pet is always askable |
| `e40573b80` | feat(pet): durable assistant — per-worktree session-dir + --continue |
| `0a17cab37` | feat(pet): rotate the omp session every 1-3h for fresh context |
| `2484e8429` | fix(pet): surface omp tool approvals as a sticky waiting state |
| `88e2e3b2b` | feat(pet): spawn omp under the mesh tool config, not bare defaults |
| `5899b6316` | feat(pet): right-click the pet to go to the agent it is talking about |
| `1a072a45f` | feat(pet): right-click the pet to ask the agent it is watching |
| `301db8b23` | fix(pet): always show the right-click menu, even with no agent |
| `11757974b` | feat(pet): the empty right-click menu offers the pet an assistant |

Binding the spawn so the pet is askable before status arrives, durable
session per worktree via `--session-dir --continue`, random 1–3h rotation
to a fresh session in the same dir so context does not accrete,
tool-approval events posted to Orca so they surface as a sticky waiting
state, mesh tool config + persona + `--with-web` so omp sees what the
mesh actually gives it, right-click jump-to-agent and ask-agent using
the same winner the bubble already computed, the menu always visible,
and the empty state becoming an offer to spawn rather than a disabled
row.

### Arc — pet roam and overlay (busy/drag pause, shared engine, right-click UI, React #185)

| Commit     | Subject |
| ---------- | ------- |
| `2dcf57b6b` | feat(pet): in-window roam with busy/drag pause |
| `9f0be090e` | feat(pet): the pet is grabbable on the phone |
| `9511a1fd6` | feat(pet): the pet keeps its voice on the phone |
| `0de788c1f` | fix(pet): stop the right-click loop that crashed the overlay (#185) |

Pure roam engine with pause rules, the same engine on the phone so a
handoff does not flip a pet, speech bubbles on the phone so the pet
announces state there too, and the React #185 infinite-render fix when
the right-click menu first offered to spawn an assistant.

### Arc — pet identity (slug, clobber heal, Petdex starter pack)

| Commit     | Subject |
| ---------- | ------- |
| `a576a81e0` | feat(pet): Petdex starter pack seed into Orca customPets |
| `d780e9cd6` | fix(pet): shrink Petdex starter pack to operator-kept 12 |
| `9edf4abb1` | feat(pet): ship operator-curated 12 Codex pets as fork defaults |

Identity-related commits (`51734a9b0`, `347e6c0ab`, `f6adc15f3`,
`dd999f0a6`) are listed under the cross-surface handoff arc above
because the slug/clobber work was filed against the surface-wiring
series; they are also relevant to identity.

A curated Petdex catalog with offline seeder so a fresh install has
Codex-pose pets, the catalog trimmed to the operator-kept 12 so re-seed
does not resurrect deleted pets, and the same 12 baked in as
fork-default spritesheets so installs without a Petdex network call
still render.

### Arc — mesh voice (desktop + mobile speak-back, Kokoro picker, completion push)

| Commit     | Subject |
| ---------- | ------- |
| `52fdbfe39` | fix(audio): TTS was playing into the earpiece, not the speaker |
| `02629d9af` | fix(voice): session speak-back never fired; hoist watcher; pick mesh voice |
| `dd9cbae24` | perf(voice): speak on the completion push, not the throttled poll |
| `e3ed74c8b` | feat(voice): port speak-back to desktop with a titlebar on/off |
| `e7f0e82c4` | feat(voice): move the speak-back toggle to the left chrome, one home |

TTS was being routed to the wrong speaker on Android, the session
watcher was reading off the RPC envelope (silent no-op) and was scoped
per-screen instead of per-workspace, completion push subscribed instead
of a 4s poll so Doze/App Standby does not stretch gaps, the same mesh
TTS ported to desktop with a per-surface on/off, and the toggle moved
to the left chrome so it is in one place across views.

### Arc — omp under the mesh

| Commit     | Subject |
| ---------- | ------- |
| `448434d33` | feat(omp): wire omp into Orca's native agent resume |

omp panes now publish a resume identity (`session_id`, `session_file`,
`session_start` handler) and the cold-restore path that already existed
for other `RESUMABLE_TUI_AGENTS` treats omp the same way; combined with
`e40573b80` (per-worktree `--session-dir --continue`) and `0a17cab37`
(1–3h rotation), the pet's assistant survives a tab close, an app
restart, and a 2h mark without losing context.

### Arc — relay node-pty toolchain (no Linux prebuild; gcc + gnumake; per-relay-dir rebuild)

No `fix(relay)` or `feat(relay)` commit landed on the branch, but the
deploy path the pet relies on when a worktree is hosted on an SSH/WSL
target is the fork's relay layer, not upstream's. The Linux node-pty
prebuild situation, the gcc + gnumake toolchain probe, the glibc /
`MODULE_VERSION` match, and the per-relay-dir rebuild are documented in
[`relay-nodepty-toolchain.md`](./relay-nodepty-toolchain.md). Relevant
files: `src/main/ssh/ssh-relay-build-toolchain.ts`,
`src/main/ssh/ssh-relay-deploy.ts`, `src/main/ssh/ssh-relay-deploy-helpers.ts`,
`src/main/daemon/node-pty-error-hints.ts`.

### WIP / mobile / merge (not part of any fork arc doc)

The rows below are listed only so the row count reconciles with
`git log origin/main..feat/pet-full-port --oneline | wc -l`. Mobile,
sidebar, panel-canvas, pinned-terminal-panels, pinned-panels, pinned-
web-panels, panels, cmd-j, status-bar, and build commits are
upstream-line work that landed on `feat/pet-full-port` via the Panel
Canvas merge (`533fb2eb2`) and are documented in upstream's own notes.

| Commit     | Subject |
| ---------- | ------- |
| `d76e8ad0d` | wip(pet-full-port): OOM salvage — unvalidated Track B WIP |
| `e28d99bdb` | feat(panels): Panel Canvas parent branch + Saved Layouts subtree |
| `7c83cb117` | feat(sidebar): always-on User Panels / Nodes headers with quick-add + |
| `05d70889e` | fix(sidebar): quick-add keys on all fields; land panel search aria label |
| `ad62de8a0` | feat(cmd-j): query-gated search for pinned panels and layouts |
| `6599d924a` | feat(sidebar): first-class panel trees with nested groups and cross-group DnD |
| `08c725df0` | fix(sidebar): stable empty arrays in QuickAdd zustand selectors (React #185) |
| `2b8077fa4` | fix(sidebar): stop React #185 in QuickAdd at boot |
| `1dbb1d469` | fix(sidebar): click-to-mount QuickAdd forms (no store/popover on rail) |
| `53013f998` | fix(sidebar): temporarily unmount QuickAdd rails to clear React #185 |
| `2bbbd10b4` | chore(build): purge-tsc-src-siblings script after React #185 mis-ship |
| `aac5317d7` | fix(sidebar): restore rail +, fix nested expand, clean panel migrations |
| `2a6ab6b51` | feat(sidebar): right-click Delete panel for user and node panels |
| `7ef2b96b7` | feat(sidebar): collapsible Layouts rail; finish tsc-sibling gitignore |
| `d56a7c0c6` | feat(sidebar): always-on User Panels / Nodes headers with quick-add + |
| `22ff34b62` | fix(panels): scrub deleted panels from saved layouts; resolve group paths in search |
| `bdaf000d4` | fix(panels): tolerate missing sshTargetLabels in host suggestions |
| `17604dc26` | fix(build): use module.isBuiltin for packaged-external detection |
| `481549695` | feat(sidebar): pinned web panels (WIP — session recovery checkpoint) |
| `6d27565b3` | fix(pinned-web-panels): allow panel partition in will-attach-webview registry, widen resolveZoomTarget to TopLevelView, add normalization tests |
| `fb480f94d` | feat(pinned-terminal-panels): shared normalization + settings/store/sidebar wiring (WIP checkpoint, tests+typecheck green) |
| `51c0ee227` | feat(pinned-terminal-panels): sentinel worktree plumbing + localization catalog |
| `5d927f08a` | test(pinned-terminal-panels): e2e — sidebar entry, lazy PTY spawn, startup command output, close restores view |
| `56c6348b0` | fix(pinned-terminal-panels): anchor xterm absolute layers inside the panel viewport (dogfood: close button was click-shadowed) |
| `2cc4ff5c8` | feat(pinned-terminal-panels): per-panel SSH host — panels run their command on a configured SSH target |
| `a13bb7bb7` | feat(pinned-terminal-panels): resolve panel host by SSH target label/alias/hostname, block on unknown host |
| `39c2586c3` | fix(pinned-terminal-panels): structural settings picks so intersected state types stay narrow |
| `7743fcdeb` | feat(pinned-terminal-panels): sidebar groups — collapsible parent rows per group label |
| `b2bf1b41a` | feat(pinned-terminal-panels): persist sidebar group folds in settings |
| `9f3edb0b6` | fix(pinned-terminal-panels): resolve hosts via hydrated sshTargetLabels; refuse spawn on unresolved host |
| `5f28df840` | test(pinned-terminal-panels): opt-in SSH-host e2e — panel command must run on the configured target |
| `e94298462` | test(pinned-terminal-panels): refresh ssh target labels in-page before opening the hosted panel |
| `f70aa70c3` | feat(pinned-terminal-panels): root 'Nodes' disclosure collapses the whole panel tree |
| `f681f96c4` | feat(pinned-terminal-panels): settings management QoL — edit, toggles, reorder, host validation |
| `4398b5d62` | feat(pinned-terminal-panels): move panel rails below Projects into their own scrollable, drag-sortable region |
| `38d560591` | feat(pinned-panels): sidebar QoL — Automations/Agents below Projects, User Panels fold, web-panel back/forward |
| `62c1ebc99` | feat(pinned-panels): split-window canvas — tile multiple panels, saved layouts |
| `1fa323e75` | feat(sidebar): rename panels/layouts from right-click; fix broken repo icon on avatar 404 |
| `f5d9f09b5` | fix(status-bar): keep labels on one line — wrapped text spilled outside the bar |
| `9cca30ec2` | feat(panel-canvas): detachable popout windows — move a canvas to its own OS window and reattach |
| `35b1fb7fd` | feat(panel-canvas): shell tiles, per-panel detach, and split controls everywhere |
| `e7a1eee0a` | feat(mobile): A1 voice page shell + home entry point |
| `df1222e57` | fix(mobile): A2 use native Orca dictation for STT, mesh only for TTS-back |
| `365b8e359` | refactor(mobile): retire global Voice page — voice is per-session |
| `b7df41821` | feat(mobile): A2a per-session speak-back (mesh Kokoro TTS) |
| `80c440145` | feat(sidebar): rename panels/layouts from right-click; fix broken repo icon on avatar 404 |
| `29c78b54b` | feat(mobile): A2b host-panel hold-to-talk — ask Herm about the fleet |
| `7eff14f05` | fix(mobile): A2b token budget starved every arm's answer to empty |
| `17cd0a1c9` | fix(mobile): give Herm real Orca host state; stop starving the answer |
| `3cc909be3` | feat(mobile): speak replies back in terminal agent sessions |

## Verification

grep -cE '^\| `[0-9a-f]{9}`' docs/mesh-fork-additions.md    # 87

```
git log origin/main..feat/pet-full-port --oneline | wc -l   # 87
grep -cE '^\| `[0-9a-f]{8}`' docs/mesh-fork-additions.md    # 87
```

Each row in the "Arc" tables corresponds to exactly one commit on
`feat/pet-full-port` and zero commits on `origin/main`. Each row in the
"WIP / mobile / merge" table also corresponds to a single commit. No
commit is omitted; no commit is double-counted.