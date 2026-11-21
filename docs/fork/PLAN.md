# rodrillet/orca — fork plan

Custom Orca for one owner: a Mac (Apple Silicon) running the desktop app and paired VPSes running
`orca-server`. Upstream is [stablyai/orca](https://github.com/stablyai/orca) (MIT). UX reference:
agentes.chat (`rodrillet/agentes-chat`, branch `vps-zen`, PR #1: agent photo + per-agent sidebar).

## Base and compatibility

- **Base: upstream tag `v1.4.266` (`903c91e80fb`)**, the exact build the owner runs on the Mac and on
  the VPS (`orca-serve` user service). Same wire protocol, same data schema, zero skew.
- Fork `main` follows **upstream release tags, not upstream `main`**. Release tags are cut off upstream
  `main` with a version bump, so each sync is a normal merge. The desktop app and `orca-server` are
  always built from the same merged tree, so they stay protocol-compatible with each other.
- `package.json` keeps upstream's version. The fork is marked by a build flag (`ORCA_FORK_BUILD`), not
  by a version suffix, so the desktop↔server version checks behave exactly as upstream's.
- Every fork feature is designed to work against a **stock** `orca-server` of the same version when
  possible (it uses RPCs the server already has). Features that need server-side code say so and are
  gated by a capability check, so a stock server degrades instead of breaking.

## Keeping merges easy

- Fork code lives in its own modules: `src/shared/fork/`, `src/main/fork/`,
  `src/renderer/src/components/fork/`, `docs/fork/`, `.github/workflows/fork-*.yml`.
- Upstream files get only small touch points (an import plus a mounted component or a guarded call),
  each marked `// fork:` so conflicts are easy to find (`git grep -n "fork:"`).
- Features are behind flags in `src/shared/fork/fork-features.ts`, on by default in fork builds.
- Upstream's 77 workflows are **disabled in the fork** through the Actions API (no file changes, so no
  merge conflicts); the sync job disables any new upstream workflow it brings in. Fork CI is
  `fork-ci.yml`.

## Phases

Each phase is one PR against fork `main`, merged when fork CI is green.

### Phase 0 — Foundation and update pipeline (feature 7)

| Piece                                                                                                                                                                                                                                                                       | Where                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Fork flag module                                                                                                                                                                                                                                                            | `src/shared/fork/fork-features.ts`, build define `ORCA_FORK_BUILD`                               |
| Updater off in fork builds: no upstream feed check, no auto download, and **no pushing upstream server updates to paired servers**                                                                                                                                          | guard in `src/main/updater/lifecycle/updater-setup.ts` and the remote-server update entry points |
| `publish` points at `rodrillet/orca`                                                                                                                                                                                                                                        | `config/electron-builder.config.cjs` (env-driven, upstream default unchanged)                    |
| Fork CI on PRs/push: install, typecheck, lint, unit tests of changed + fork modules                                                                                                                                                                                         | `.github/workflows/fork-ci.yml`                                                                  |
| Sync: daily + on dispatch, find newest upstream release tag; if newer than what `main` holds, merge it on a `sync/vX` branch, open a PR; CI green → auto-merge → build. Conflict → open an issue with the conflicting files (and a draft PR with conflict markers left out) | `.github/workflows/fork-sync.yml`                                                                |
| Build: macOS arm64 `.app` zipped (ad-hoc signed, unsigned/unnotarized) on `macos-14`, and `orca-server` linux-arm64 tarball on `ubuntu-24.04-arm`; both attached to a GitHub Release `vX-fork.N`                                                                            | `.github/workflows/fork-build.yml`, reusing upstream's packaging scripts                         |

**User data**: the app keeps upstream's `appId` (`com.stablyai.orca`) and product name, so it reads and
writes the same `~/Library/Application Support/orca`. Replacing the `.app` never touches that folder.
Upstream schema migrations run forward exactly as on a normal upstream update. (Going back to an
_older_ official build after a newer fork build is the only unsafe direction, same as upstream.)

**Why the updater is off rather than pointed at the fork**: macOS Squirrel/ShipIt only installs an
update whose code signature matches the running app; an ad-hoc signed build can't satisfy that. With a
Developer ID certificate in the fork's secrets this can be switched to the fork's release feed later.
Until then, updating = download the zip from the fork's Releases and replace the app.

### Phase 1 — Bot photos and the agent sidebar (features 1, 2)

Upstream 1.4.266 already has most of this: per-bot upload (`bots.avatar.upload`, cropped 512 px PNG in
the bot's home), mascot or AI-generated default pictures, the picture shown in the sidebar, chats and
groups, a status badge on the picture (working / needs you / idle), the newest line + age, unread
mark, and a fold that lists the bot's chats and workers.

Gaps to close (renderer only, works with a stock server):

- Unread **count** (not just a dot) per bot and per chat, like agentes.chat.
- Expanded chat rows show last message, age or unread count, and a spinner where the bot is working.
- Upload entry point visible from the bot's row menu ("Change photo…"), not only from settings.

### Phase 2 — Organization and machines (features 3, 6)

Model: **Departments > Sections**, two levels, each bot (and bot group) in at most one place; a
department can hold bots directly, so a flat set of groups is just departments without sections.
This mirrors Orca's existing two-level "project group > project" sidebar.

- Stored by the desktop in `userData/fork/organization.json` (own IPC, keyed by `hostId/botId`), so
  it works for bots on any paired machine without a server change. Not synced to the phone (v1).
- Sidebar "Bot options" gains **Group by: None · Machine · Organization**. Machine groups bots (and
  their chats) under "This Mac", "VPS 1", … using the paired environment names; Organization shows
  departments/sections with drag & drop and a "Move to…" menu; create/rename/delete inline.
- Workspaces: a **Machine** option in the projects' Group by, so one window shows every paired
  environment's workspaces grouped by computer (agentes.chat "computers").

### Phase 3 — Agents in Tasks (feature 4)

A new **Agents** source in the Tasks page: one card per bot across all machines with what it is doing
now (`bots.activity` / now line), its items by status (`bots.items.owner.list`), its worker dispatches
with status and linked PRs (`bots.work.list`, orchestration dispatches), and quick links to open the
chat or the item. Renderer only; all RPCs exist in the stock server.

### Phase 4 — Teams of agents (feature 5)

What upstream already allows: a bot can propose new bots (`orca bot create --offer` → a card the owner
presses), bot groups (shared room, @Name hand-off, peer requests), items for another bot
(`orca bot items add --for <bot>`), and orchestration workers.

Gaps to close:

- **Team builder permission** per bot (owner opt-in, off by default): offers from that bot are
  accepted automatically (`bots.create` with `fromOffer`, the same path as pressing Create), with a
  cap on how many bots it may create per day and a toast/audit line for each.
- **Team channel**: bots created from one bot's offers join a bot group "<Lead>'s team" with the lead,
  created/updated automatically, so they share one room and context.
- **Delegation without approvals**: in a team group, members may hand off (@Name) and file items for
  each other without the owner approving each step; the owner sees it all in the group and in Tasks.
- Client-driven in the desktop first (works with a stock server while the Mac is open). Running it with
  the Mac closed needs the same logic inside `orca-server` → fork server build (capability-gated).

## Decisions for the owner

1. Base v1.4.266 and track upstream **release tags** (not upstream `main`).
2. Auto-update off in the custom build; updates are manual from the fork's Releases until a Developer
   ID certificate is added. The app is ad-hoc signed: first launch needs right-click → Open (or
   `xattr -dr com.apple.quarantine /Applications/Orca.app`).
3. Organization lives on the Mac (not synced to the phone in v1).
4. Fully autonomous teams with the Mac closed require installing the fork's `orca-server` on the VPS.
