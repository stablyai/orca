# Agent Status over WSL (STA-1515)

Status: implemented and rig-validated (2026-07-09 round 3 + 2026-07-10 round-4 re-run
pinned to the hardened build, Windows 11 + WSL2 NAT): Claude end-to-end live —
provisioning, working→done in the store, completion toast, loopback-only posture, and
restart resume over a daemon-surviving PTY with the instance-keyed endpoint dir reused
across restarts. The round-4 re-run also proved the `--exec` spawn form live (host
process table) and the stale-exit reinstall upgrading the guest to the new bundle
version in place. Residual: Codex's done/Stop leg unproven live — env-blocked on the
rig (no dev-profile Codex credentials AND the model backend is unreachable from the
guest under NAT); everything that fired behaved correctly. Confirm on a credentialed
rig with a guest-reachable backend, ideally on a fresh distro to also observe the
deferred Codex trust entries landing after config.toml is seeded.
Owner: brennanb2025. Linear: STA-1515.
Precedent this mirrors: the SSH agent-hook relay (`src/relay/agent-hook-server.ts`,
`src/shared/agent-hook-relay.ts`, ingest at `agentHookServer.ingestRemote` in
`src/main/agent-hooks/server.ts`).

## Background — how we got here

GitHub issue `7565` reported OMP agents in WSL worktrees disappearing from the worktree
sidebar after v1.4.124. Diagnosis split it into a regression and a pre-existing class gap:

- The **regression** was a title-normalization change (PR `7447`) that stopped idle OMP
  titles from producing the sidebar's title-derived fallback row. Decision: the sidebar is
  moving to **hook-driven rows only** (fallback removal in flight, separate PR), so the
  fallback was not restored.
- The **class gap** is that agent hooks have never worked from inside WSL for any agent.
  Two scoped PRs fixed it for OMP alone (merged, live-validated on a Windows+WSL2-NAT rig):
  - PR `7642` — Orca-managed WSL shells wrap interactive `omp` invocations with
    `--extension "$ORCA_OMP_STATUS_EXTENSION"` (the env var is WSLENV `/p`-translated so
    the WSL process reads the extension out of the Windows filesystem via `/mnt/c`).
  - PR `7641` — when the extension's loopback POST cannot connect, it delivers via
    Windows-side `/mnt/c/Windows/System32/curl.exe` (a Windows process, so *its*
    `127.0.0.1` is the loopback Orca actually binds). Fire-and-forget spawn,
    `--noproxy 127.0.0.1`, memoized WSL/curl probes, load-tolerant timeouts
    (`--connect-timeout 3 --max-time 10`; 0.5s dropped events under load).

This document is the full context for the general fix: every other hook client is still
dead from WSL, and the hooks-only sidebar change makes this work the gate for the
Windows+WSL story.

## Why hooks don't work on Windows+WSL — two independent gaps

### Gap A — transport

The hook listener binds `127.0.0.1` only, deliberately (`src/main/agent-hooks/server.ts`,
`listen(0, '127.0.0.1')`; auth via `X-Orca-Agent-Hook-Token`, 403 otherwise). Every hook
client POSTs to a hardcoded `http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/hook/<source>`.

WSL2 under default **NAT** networking is a VM with its own network namespace. Microsoft's
localhost forwarding is **one-way (Windows→WSL only)**: `127.0.0.1` inside WSL is WSL's
own loopback, so every POST dies `ECONNREFUSED` — silently, because hook clients are
deliberately fail-open. Reaching Windows from WSL would require the host vNIC IP (changes
per boot) + a non-loopback listener bind + a firewall rule — all three conflict with the
loopback-only security posture.

The env coordinates DO cross correctly (`src/main/pty/wsl-orca-env.ts`
`addOrcaWslInteropEnv`: WSLENV `PORT/u TOKEN/u ENV/u VERSION/u` plus
`ORCA_AGENT_HOOK_ENDPOINT/p` path-translated; called from `src/main/ipc/pty.ts` and
`src/main/daemon/pty-subprocess.ts`). The address is simply unreachable.

Opt-in **mirrored** networking (Win11, `.wslconfig`) shares loopback and makes plain fetch
work — the fix must not fight it. No `wslinfo` probing is needed: under mirrored mode the
relay's preferred-port bind collides with the Windows listener and the `EADDRINUSE`
fallback (below) handles it, while clients that go straight to the shared loopback reach
the Windows listener directly. Both delivery paths stay valid.

### Gap B — installation

Hook configs and scripts are written to the **Windows** home by every hook service:
Claude `settings.json` + managed scripts, Codex config, Gemini/Cursor/Droid/Devin/Grok/
Copilot scripts, Amp/OpenCode plugin files, the Pi/OMP extension file. An agent inside WSL
reads the **WSL-side** `$HOME` and sees none of it. There is zero WSL-targeted install
code in `src/main/agent-hooks/` or any hook service. SSH remotes have the exact precedent
needed: dedicated remote installers (`src/main/ssh/ssh-relay-session.ts` remote
settings.json handling; PR `7744` installed Droid/Copilot hooks over SSH).

Consequence: even mirrored-networking users get no hooks — transport fine, configs absent.
OMP escapes Gap B by *pointing across* the boundary (`/mnt/c` path via `/p` translation)
rather than installing WSL-side; that trick can carry file *content* for some clients, but
shell hooks still execute inside WSL and then hit Gap A regardless.

## Transport map — every client, how it posts

Endpoint file contract: `writeEndpointFile` (`src/shared/agent-hook-listener.ts`) emits
exactly four keys (`ORCA_AGENT_HOOK_PORT/TOKEN/ENV/VERSION`) to `endpoint.env` (POSIX) /
`endpoint.cmd` (Windows) — **no host field**. Shell clients source it to refresh stale
coords after an Orca restart; node clients parse it. It is never executed as a delivery
script. Clients prefer endpoint-FILE coords over env (restart re-coordination) — any
transport change must preserve that property.

| Client | Mechanism | Runtime that POSTs |
| --- | --- | --- |
| Claude, Codex, Gemini, Cursor, Droid, Devin, Grok | managed shell script | `curl` (POSIX) / `curl.exe` (Windows), built in `src/main/agent-hooks/installer-utils.ts` |
| Copilot | managed script | `curl` (POSIX) / PowerShell `Invoke-WebRequest` (Windows) |
| command-code | managed script (parse-not-source hardened) | `curl` |
| Amp, OpenCode | in-process node plugin | `fetch` |
| Pi / OMP | bundled in-process extension (`src/main/pi/agent-status-extension-source.ts`) | `fetch`, now with the WSL curl.exe fallback |

All of them target `127.0.0.1`.

## Status quo + why this gates the hooks-only sidebar

Today the worktree-card rows still have a title-derived fallback producer
(`src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts`), so WSL users
DO currently see rows for title-rich agents (Claude `✳`/spinner titles, Gemini glyphs) —
degraded (generic text, no prompt/last-message preview, no notifications) but present.
Title-poor agents are dark (Codex — hence GH `6907`). When the hooks-only change removes
that producer, **every non-OMP agent in a WSL worktree loses its card row entirely until
this work ships**. Hook fidelity adds: prompt + last-assistant-message previews,
waiting/blocked precision, completion notifications, AI Vault / native chat session
integration.

## Solution design — WSL relay + WSL-side installation

### Transport (Gap A): guest-resident relay, host-owned stdio

Run a small receiver **inside WSL on WSL's own loopback, listening on the very port the
clients were already given** (`$ORCA_AGENT_HOOK_PORT` — free inside WSL, since that port
only exists on the Windows side). Unmodified clients then deliver successfully with
**zero client changes**; the reporter's diagnostic relay in GH `7565` proved this shape
live. Forward each parsed envelope to the Windows host over the relay's **own stdio**
(Orca spawns it via `wsl.exe`, so it owns that pipe). Ingest through the existing trust
boundary: `agentHookServer.ingestRemote` (`src/main/agent-hooks/server.ts`), envelope
shape `src/shared/agent-hook-relay.ts` — identical to the SSH relay, which runs a
loopback-only receiver on the remote box and forwards over the SSH control channel.

**Port binding.** Bind the inherited `$ORCA_AGENT_HOOK_PORT` first — it keeps every
already-crossed coordinate (env and the `/p`-translated endpoint file) truthful with zero
divergence. On `EADDRINUSE` inside the guest, fall back to the SSH relay's own pattern:
bind `127.0.0.1:0`, write a **WSL-side endpoint file**, and point WSL PTYs'
`ORCA_AGENT_HOOK_ENDPOINT` at it (clients already prefer endpoint-file coords over env).
The relay writes that WSL-side endpoint file in **both** modes so restart re-coordination
never depends on `/mnt/c` translation being readable.

Lifecycle: one relay per distro **per Orca instance** (concurrent instances have distinct
ports, so guest listeners never collide); **ensure** — not just start — whenever a WSL PTY
exists: first spawn *and* daemon-PTY reattach after an Orca restart (WSL PTYs survive in
the daemon; the new instance has a new port + token and must respawn the relay before
surviving agents re-coordinate). The relay **exits when its stdin closes**: a lingering
guest listener would let WSL's own Windows→WSL forwarder grab the freed Windows-side port
and blackhole stale Windows-side hook posts. Restart if WSL restarts; token still
validated at the relay's HTTP receiver; harmless under mirrored networking (bind
fallback) and inert on non-WSL platforms (ensure only fires from WSL PTY spawns).

Reliability contract (invariant class `agent-session.hook-transport`): hook clients are
fail-open silent, so the relay must not be — spawn failures, `EADDRINUSE` fallback, and
forward errors each leave a diagnosable breadcrumb; the `wsl.exe` "Catastrophic failure
(E_UNEXPECTED)" retry is **bounded** with backoff, never a spawn loop. Oracle: provider-
contract tests with fault injection (stdin close → exit, occupied port → fallback + file
rewrite, envelope round-trip to `ingestRemote`) rather than end-to-end flows only.

Design notes from a survey of comparable WSL-capable tools (kept nameless per policy):
- Guest-resident component + host-owned channel + guest-side installation, explicitly
  reusing the tool's SSH-remote machinery, **is the established pattern**. No surveyed
  tool makes guest processes dial back to a Windows-localhost listener — the merged OMP
  curl.exe stopgap is the outlier as a primary path (but see the round-4 revised
  stance below: it survives as the no-node fallback).
- Prefer host-owned **stdio** over Windows→WSL localhost port forwarding (wslhost
  forwarding is known-flaky under load; one surveyed tool dials the distro vNIC IP just to
  avoid it — stdio sidesteps the question entirely).
- WSL offers no persistent control channel between separate `wsl.exe` invocations —
  collapse the relay's ensure-installed + launch into **one idempotent script per spawn**.
- Install into the guest from inside the guest (download/extract in WSL) or stream the
  binary through `wsl.exe` stdin — not by copying through `/mnt/c`.

### Installation (Gap B): WSL-side hook installers

Write agent hook configs/scripts into the WSL-side home, per agent, analogous to the SSH
remote installers — via `wsl.exe`-executed scripts (preferred, mirrors SSH most closely)
or `\\wsl.localhost\<distro>\...` writes. Without this half, the relay receives nothing:
the hook clients themselves are absent from the WSL filesystem.

## Alternatives considered (and why not)

1. **Endpoint-file host/URL field** — the file already crosses into WSL (`/p`-translated),
   but clients read only PORT/TOKEN and hardcode the host, so all ~13 still need edits;
   and a WSL-reachable listener bind breaks the loopback-only posture (LAN exposure,
   firewall prompts).
2. **Replicate the curl.exe bridge per client** — the shell clients share ~2 generated
   builders so it is cheaper than it sounds, but it is N point fixes, requires WSL interop
   enabled (`/etc/wsl.conf` can disable it), pays a per-event process spawn (load-sensitive,
   see validation facts), and keeps the ecosystem-outlier direction.
3. **Listener-side bind changes / rely on mirrored networking** — posture conflict /
   opt-in only.
4. **OSC 9999 in-band status** (`src/shared/agent-status-osc.ts`, parsed per-pane in
   `pty-transport.ts` and `orca-runtime.ts`) — zero-network and pane-attributed, but only
   viable for in-process clients and carries status payloads, not the full hook event
   vocabulary (prompts, tools, completion) — cannot replace the pipeline.

## Facts + gotchas from the 2026-07-08 Windows-rig validation

- curl.exe interop delivery works under NAT (shipped for OMP), but per-event process spawn
  is load-sensitive: `--connect-timeout 0.5` dropped 3/3 events to a *healthy* listener
  under load; fine at 3s. A resident relay avoids per-event spawns entirely.
- `wslinfo --networking-mode` distinguishes NAT vs mirrored.
- Clients prefer endpoint-FILE coords over env. Testing gotcha: unset
  `ORCA_AGENT_HOOK_ENDPOINT` in synthetic tests or events go to the real running app.
- Server ingest silently drops paneKeys that are not `uuid:uuid`-shaped — use real-shaped
  keys in synthetic validation.
- OMP is a Bun single-file binary; Bun's `node:child_process`/`fetch` compat held. Other
  in-process clients run inside their agents' runtimes — verify per runtime.
- Environmental: fresh WSL 2.7.10 intermittently threw "Catastrophic failure
  (E_UNEXPECTED)" from `wsl.exe -d <distro> -- bash -lc` under concurrent spawn load
  (cleared by `wsl --terminate`). The relay spawn path should tolerate/retry this.
- Fork-PR CI runs sit in `action_required` until approved:
  `gh api repos/stablyai/orca/actions/runs/<id>/approve -X POST`.

## Acceptance

On a default-config Windows 11 + WSL2 **NAT** machine: launch **Codex or Claude**
(explicitly not OMP) in a WSL worktree → live hook-driven worktree-card row with status
transitions and a completion notification; hook listener still bound to Windows loopback
only; zero per-client transport changes; hooks installed WSL-side automatically (no manual
config); harmless under mirrored networking and inert on non-WSL platforms. After an Orca
restart with the WSL agent still running (daemon-surviving PTY), status events resume
without relaunching the agent.

## 2026-07-09 Windows-rig validation follow-ups

The first live GUI run proved every mechanism in isolation but failed end-to-end, yielding
two fixes:

1. **Link death must be handled, not just child death.** A mux protocol error or timeout
   can kill the host↔guest link while the guest process (and its 204-returning receiver)
   stays alive — the exact observed signature: hooks POST 204, store never populates.
   `wsl-hook-relay-link.ts` now guarantees exactly-once death handling from either signal;
   the manager breadcrumbs it, kills the child, and self-restarts after a short cooldown
   (a live agent session produces no new PTY spawns to re-trigger ensure).
   `ORCA_WSL_HOOK_RELAY_DEBUG=1` traces every received envelope pre-ingest so a live rig
   can pinpoint any residual drop. The full host chain is pinned by a live integration
   test (real bundle over real child stdio through the real manager into a real
   `ingestRemote`).
2. **(Round 2) The renderer's SSH-era ownership gate dropped `wsl:*` events.** With the
   link fixed, envelopes reached `ingestRemote` and the durable cache, but
   `useIpcEvents.applyAgentStatus` compares the stamped connectionId against the owning
   repo's — `"wsl:<distro>" !== null` for a local repo, so every WSL-relayed status died
   before `setAgentStatus`/notifications. Fix: `wsl:*` ids are transport provenance, not
   ownership — the gate normalizes them to local (null) via
   `isWslHookRelayConnectionId`, while still rejecting WSL-stamped events against
   SSH-owned repos. Provenance stays stamped (it made the drop diagnosable in the first
   place).
3. **Codex reads a redirected home.** Orca launches WSL Codex with `CODEX_HOME` pointed at
   the managed runtime home (`~/.local/share/orca/codex-runtime-home/home`), so installing
   hooks to `~/.codex` left Codex dark. The installers now accept an explicit codex home;
   the trust write into `config.toml` is deferred while that file doesn't exist (the
   launch path seeds it only-if-absent — creating it first would cancel the seed), and the
   manager re-runs the idempotent installers on later ensures (throttled) to upsert trust
   once the seed lands. Consequence: the very first WSL Codex session after a cold relay
   may miss hooks; the next one has them.

## 2026-07-09 adversarial-review hardening (pre-rig round 3)

Four independent review lenses over the full diff; confirmed findings fixed:

- **Endpoint identity (all 4 reviewers)**: the guest endpoint dir was keyed by the
  ephemeral Windows hook port, so a daemon-surviving agent kept sourcing the DEAD
  `port-P1` file after an Orca restart — breaking the restart-resume acceptance criterion
  and regressing shipped OMP recovery. Now keyed by a restart-stable instance key
  (hash of the Windows endpoint file path = userData + namespace, crossed via
  `ORCA_WSL_HOOK_INSTANCE`): the restarted instance's relay REWRITES the same file, which
  is exactly what re-coordinates survivors.
- **Restart policy**: every failure now arms the restart timer (one failed relaunch no
  longer ends self-recovery), and the timer probes `wsl --list --running` first — `wsl -d`
  BOOTS a stopped distro, so recovery must never resurrect a VM the user shut down; a
  stopped distro's state is dropped instead (next WSL terminal re-ensures). Failure
  counters only reset after 2 min of stable uptime, so connect-then-die loops escalate to
  the 10-min cap instead of cycling every 10s.
- **Install-dir versioning**: the guest install dir is namespaced by bundle version, so
  concurrent Orca instances with different bundles (dev + prod) never reinstall over each
  other; tmp files carry the guest PID. The install spawn also gained the 30s timeout it
  was missing (a wedged wsl.exe could previously pin the state machine at 'starting'
  forever).
- **Guest node resolution**: candidates (PATH, nvm glob, fixed paths) are each
  version-probed, first pass wins — an apt node 12 on PATH no longer masks an nvm node 20
  into a false "no node >= 18" 10-minute cooldown.
- **wsl.exe text handling**: `WSL_UTF8=1` on all spawns + NUL-stripping on stderr, so the
  "Catastrophic failure" transient-retry matcher and breadcrumbs survive UTF-16LE output.
- Smaller: ordered post-sentinel chunk handoff (frame-decoder desync race), port-fallback
  breadcrumb now reaches host logs via the home handshake, bad home reply fails the
  connect (was: silently 'running' without installs), missing-bundle warn-once, distro
  map keys case-normalized, `disposeAll` wired to app `will-quit`, single-spawn Codex
  trust catch-up via a one-shot 60s reinstall timer.

Accepted gaps (reviewed, deliberately not addressed here): old version-namespaced
install dirs accrete across upgrades (~200KB each); an outdated running daemon
/p-translates the guest endpoint path until it restarts (hook scripts fall back to env
coords, which same-port binding keeps correct); `wslDistroCache` caches a transient
empty list for the app run (pre-existing semantics, now load-bearing for default-distro
resolution); default-distro resolution caches the first answer for the app run.

## 2026-07-09 round-4 external adversarial review

A second adversarial sweep (five independent lenses: guest relay + fs bridge, host
lifecycle state machine, app integration + renderer gate, design-vs-alternatives, and a
platform fact-check of every WSL claim). Design verdict: the guest-resident relay over
host-owned stdio is the right architecture — the zero-per-client-change chokepoint is
what the curl.exe alternative cannot match, and the lifecycle weight is inherent to any
guest-resident helper. Confirmed findings, all fixed on this branch:

- **`dropState` identity race (major)**: the recovery timer re-checked state identity
  only BEFORE the async `wsl --list --running` probe; an ensure() landing during the
  probe could get its fresh state deleted by key — orphaning a live relay child outside
  the map (unkillable by `disposeAll`, duplicate relay on next ensure). Fixed: identity
  re-check after the probe await + identity-guarded delete in the manager.
- **Distro-running probe failed OPEN**: any probe error (including its 10s timeout)
  reported "running", so recovery could `wsl -d` — and thereby BOOT — a distro the user
  shut down, in exactly the wedged-wsl.exe failure mode where the probe errors. Now
  fails closed: drop the state; the next WSL PTY spawn re-ensures.
- **Spawn form hardened to `--exec`**: `wsl.exe -- <cmd>` routes through the distro's
  default login shell (Microsoft docs: only `--exec` runs "without using the default
  Linux shell"), so a fish/nushell chsh could mangle the launch; `--exec sh -c`/-`s`
  bypasses it and passes argv verbatim (no `$`-preprocessing, escaping shim dropped) —
  same form as the Codex WSL login spawn.
- **Post-sentinel handoff microtask**: pending chunks flushed synchronously inside the
  mux constructor, before the manager could register notification handlers — an
  envelope arriving in the trailing bytes dispatched to zero handlers (recovered only
  by the later replay request). Flush now rides a microtask: after the caller's
  synchronous wiring, still ahead of any subsequent stdout IO event.
- **Relay process posture**: the guest relay now mirrors the SSH relay's
  `uncaughtException` (log + exit → manager respawns) / `unhandledRejection` (log +
  survive) handlers.
- **Replay cache recency cap**: the WSL relay has no per-pane teardown signal, so the
  per-pane replay cache grew for the relay's lifetime; now capped at 256 panes,
  evicting longest-idle first (meta map kept in lockstep). Backstop for SSH too.
- Smaller: guest launch script derives the stale-exit code from the shared contract
  constant (was a hardcoded 42 twin); one-shot reinstall timer refuses to arm after
  dispose; fs-bridge scope comment states the lexical (symlink-following) bound
  honestly. New oracles: sentinel unit suite (chunk splits, overflow kill, timeout,
  microtask handoff), fs-bridge scoping suite, 403 + fallback endpoint-file rewrite,
  cache-cap eviction, and the recovery/manager race regressions.

**Revised stance on the OMP curl.exe bridge — keep it, do not retire.** The relay
requires node ≥ 18 in the distro; a fresh WSL Ubuntu ships none, Codex CLI is a native
binary that brings none, and Claude Code's native installer no longer implies a system
node. A distro running only Codex would hit the no-node cooldown and stay dark — the
exact GH `6907` shape. The interop bridge is the one delivery path with no guest
runtime requirement, so it stays as the documented no-node fallback (currently wired
for OMP; extending it to the shared shell-script builders is the tracked follow-up if
no-node distros show up in telemetry). The relay remains the primary path: resident
(no per-event spawn cost) and interop-independent.

## Implementation map

- Guest: `src/relay/wsl-agent-hook-relay.ts` (entry; exits on stdin close),
  `src/relay/wsl-hook-fs-bridge.ts` (home-scoped fs RPCs for installs),
  `src/relay/agent-hook-server.ts` (`token`/`preferredPort` options + `EADDRINUSE`
  fallback). Bundled by `config/scripts/build-relay.mjs` → `out/relay/wsl/`.
- Host: `src/main/agent-hooks/wsl-hook-relay-manager.ts` (per-distro state machine),
  `wsl-hook-relay-launch.ts` (bundle resolve, guest launch/install scripts, spawn env,
  sentinel wait), `wsl-hook-relay-link.ts` (envelope forward + exactly-once link-death
  handling), `wsl-hook-relay-deps.ts` (DI seam), `wsl-hook-fs-adapter.ts` (SFTP-shaped
  adapter + `installWslGuestHooks`, which targets Codex's managed runtime home).
- Wiring: `buildPtyHostEnv` (`src/main/ipc/pty.ts`) ensures the relay on every WSL spawn
  and repoints `ORCA_AGENT_HOOK_ENDPOINT` at the guest endpoint file once known;
  `src/main/pty/wsl-orca-env.ts` picks `/u` vs `/p` by value shape.
- Contract shared by both sides: `src/shared/wsl-hook-relay-contract.ts`.
- Oracles: `src/relay/wsl-agent-hook-relay.test.ts`,
  `src/main/agent-hooks/wsl-hook-relay-manager.test.ts` (fault injection: stale-42
  reinstall, no-node-43 cooldown, bounded E_UNEXPECTED retry, exit re-ensure gating, and a
  full installer run against an in-memory guest).

## References

- GitHub: issues `6907` (Codex/WSL), `7091` + `7565` (OMP, fixed), `7563` (WSL CLI
  detection, adjacent); PRs `7642` + `7641` (OMP fixes), `7744` (SSH hook installers
  precedent), `7447` (title-collapse regression).
- Linear: STA-1515 (this work; ticket comments carry the same context).
- Key files: `src/main/agent-hooks/server.ts`, `src/shared/agent-hook-listener.ts`,
  `src/shared/agent-hook-relay.ts`, `src/relay/agent-hook-server.ts`, `src/relay/relay.ts`,
  `src/main/pty/wsl-orca-env.ts`, `src/main/agent-hooks/installer-utils.ts`,
  `src/main/pi/agent-status-extension-source.ts`, `src/main/ssh/ssh-relay-session.ts`,
  `src/main/providers/windows-shell-args.ts`, `src/shared/wsl-login-shell-command.ts`.
