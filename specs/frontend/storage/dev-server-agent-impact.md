# Storage → Dev-Server Agent Impact Assessment

Cross-reference analysis over the other three docs in this directory
(`browser-storage-catalog.md`, `ui-settings-session-hybrid.md`,
`feature-persistence-matrix.md`) — no new code sweep, just re-grouping
their already file:line-cited facts around one question: **which stored
state, if lost/stale/uncleared, actually changes how an agent running on a
dev server (a remote SSH/runtime-environment host, as opposed to local
Electron execution) behaves?** "Dev server" here = a paired remote runtime
environment (`environmentId`), not the local machine.

## Summary table (highest impact first)

| # | Item | Tier | What breaks for a dev-server agent | Severity |
|---|---|---|---|---|
| 1 | `orca.accountsDevServer.<environmentId>` | Browser localStorage, sole copy | The web "Accounts" picker's environment→dev-server mapping. `accounts.*` RPCs **throw if this is absent** (`browser-storage-catalog.md#4`) — an agent's provider-account calls (Claude/Codex account selection) on that environment fail outright until the user re-picks a dev server. Not synced to backend by design. | **Critical** — hard RPC failure, not degraded UX |
| 2 | `orca.saved-instances` | Browser localStorage, sole copy | The web client's list of self-hosted Orca servers (`{id,label,url,team?,lastConnectedAt?}`). Clearing it means the web client can't reconnect to a given dev server at all — every agent op on that host is blocked until the URL is re-typed. No backend/store equivalent. | **Critical** for web clients |
| 3 | `remote-agent-sessions.ts` slice | In-memory only, **no persistence call in file** | Tracks remote agent sessions via `agentOrchestration` IPC — this is literally the live registry of agents running on remote hosts. Confirmed lost on page refresh/app restart (`feature-persistence-matrix.md`). A refresh forces the UI to rediscover/reattach agent sessions from scratch rather than restoring known state. | **High** |
| 4 | `dev-servers.ts` slice | In-memory only, pure reducer, populated externally | The dev-server list/status itself has no persistence call — it's rebuilt from whatever populates it on each load, not restored. If that external source is briefly unavailable at startup, the UI has no last-known dev-server state to fall back on. | **High** |
| 5 | `bootstrap.ts` slice | In-memory only | Per-dev-server bootstrap-step automation (CR-004) — the sequence that brings a dev server up to a working state for agents. Holds no persistence itself, so a mid-bootstrap refresh loses progress and the sequence restarts. | **High** |
| 6 | `session` namespace (`orca.web.workspaceSession.v1`) — specifically `sleepingAgentSessionsByPaneKey`, `tabsByWorktree`, PTY↔tab bindings | Browser localStorage, **pure, no RPC on web** (`ui-settings-session-hybrid.md`) | Even when paired to a dev server, this data "stay[s] browser-local even when paired." Clearing it loses which pane/tab an agent's terminal was bound to — the underlying PTY on the dev server may still be alive, but the client loses the handle to reattach to it, so the agent looks gone from the UI. | **High** — data isn't destroyed on the dev server, but becomes unreachable from that browser |
| 7 | `ssh.ts`, `provisioning.ts`, `runtime-environment-ssh.ts`, `ssh-target-cleanup.ts` slices | In-memory only | SSH fleet import/health/credential-request state, bulk relay provisioning progress, and per-connection SSH state for dev servers reached over SSH. None persist — a refresh mid-provisioning or mid-health-check loses all progress/status and must be redone. | **Medium-High** |
| 8 | `runtime-status.ts` saved server list | Local desktop-only (Electron IPC → `orca-data.json`), **not web, not cross-device** | The canonical list of remote runtime environments (dev servers) a desktop client can target. Persists on that one machine only — a different device or the web build has no access to it, so which dev servers exist must be re-added per client. | **Medium** |
| 9 | `terminals.ts` (`window.api.pty.kill`) / `workspace-cleanup.ts` (orphan PTY detection) | Live control calls, not persisted data | Not a storage-loss risk per se, but both route through `callRuntimeRpc` for remote-host kill/cleanup — if the dev-server-identity mapping (#1/#2/#8) is stale or missing, these calls target the wrong host or fail, potentially leaving orphaned agent processes running on a dev server with no client aware of them. | **Medium** (compounding risk, not independent) |
| 10 | Web auth-failure handler (`main-web-bootstrap.tsx:92,97`) and explicit logout (`useLogout.ts:50,55`) — blanket `localStorage`+`sessionStorage` `.clear()` | Cascading | Wipes #1, #2, and #6 (and `ui`/`settings` caches) **together in one action**. After any auth failure or logout, a web client must re-add its dev server, re-pick its account/dev-server pairing, and cannot reattach to any agent session that was running on that dev server. | **High**, but scoped to an explicit/deliberate event |
| 11 | `orca.linearTicketsSkill.setupDismissed[.wsl.<distro>\|.host]` | Browser localStorage, per-runtime-scoped key | Minor: only gates whether an agent-skill setup nudge reappears per runtime (WSL distro or host). No functional effect on an agent's ability to run. | **Low** |

## Why these and not the others

Most of the catalog (`browser-storage-catalog.md` sections 1–3: onboarding
tours, panel geometry, GitHub board column widths) is cosmetic/local-UI and
has zero bearing on whether an agent executes correctly on a dev server —
excluded here. Likewise the `settings`/`ui` field-coverage gap
(`ui-settings-session-hybrid.md` standout finding #1) is a real risk, but
it's a *preferences* gap (terminal theme, proxy config, etc.), not something
that changes agent execution or reachability, so it's out of scope for this
assessment.

## Root pattern

Everything in the top half of the table above traces back to one structural
fact already flagged in `README.md`: **the Zustand store persists nothing by
default**, so for dev-server-agent state specifically there are exactly two
tiers, both fragile in different ways:

1. **Browser-local mapping keys** (#1, #2) — small, sole-copy, and
   deliberately excluded from `GlobalSettings`/backend sync ("not
   server-authoritative state" per `accounts-dev-server-connection.ts:10-15`
   comment). These are the actual *pointers* that let a client find/authorize
   against a dev server — losing them doesn't stop the dev server or its
   agents from running, but it disconnects the client's ability to control
   or observe them.
2. **In-memory slices** (#3–#7) — genuinely volatile process/session state
   about what's *currently* happening on a dev server (which agents are
   live, what bootstrap stage it's in, SSH health). Losing these on
   refresh doesn't kill the dev server, but forces a full rediscovery/
   reattachment cycle client-side.

The dev server (and any agent process actually running on it) is generally
unaffected by any of this — the impact is entirely on the **client's ability
to find, authenticate against, and reattach to** a dev server and the agents
running there. The one partial exception is #5 (`bootstrap.ts`): if a
refresh interrupts a bootstrap sequence mid-flight, the dev server itself can
be left in a partially-configured state with no client-side record of where
it stopped.

## Suggested follow-ups (not yet implemented — flagging only)

- Consider persisting `orca.accountsDevServer.<environmentId>` and
  `orca.saved-instances` through the `settings`/`ui` RPC sync (or a small
  dedicated backend-synced list) instead of sole-copy localStorage, given
  they're already called out as "annoying to lose" in
  `browser-storage-catalog.md`'s cross-cutting observations.
- `remote-agent-sessions.ts` and `dev-servers.ts` being purely in-memory
  means a page refresh during active agent work on a dev server currently
  relies entirely on rediscovery; confirm the rediscovery path actually
  reconciles with `sleepingAgentSessionsByPaneKey` (workspaceSession) rather
  than assuming a clean slate.
- The blanket `.clear()` on auth failure/logout is convenient but couples
  dev-server identity loss to every logout — worth confirming that's
  intentional and not just a byproduct of using a single "clear everything"
  helper.
