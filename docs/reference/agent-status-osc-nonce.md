# Agent-status OSC 9999 nonce gate

`OSC 9999 ; <json> (BEL | ST)` lets a process publish agent status for its pane.
Orca reads it off the PTY master, so **anything the pane prints** reaches the
parser — including text the pane's process did not author.

This page is the contract for the nonce that gates it.

## What the nonce proves — and what it does not

The nonce is a per-pane random value Orca stamps into the pane's environment as
`ORCA_AGENT_STATUS_NONCE`, next to `ORCA_PANE_KEY`. Child processes inherit it
the same way.

It authenticates **possession of pane context**: the emitter is the pane's own
process or a descendant of it. It is not an identity, a capability, or a
signature over the payload.

| Threat | Killed? |
|---|---|
| **T1 — accidental replay.** A log, transcript, or fixture containing a recorded payload is `cat`'d into a pane. | **Yes.** The recorded text cannot carry this pane's nonce. |
| **T2 — content-mediated injection.** An agent echoes attacker-controlled text (a fetched page, a dependency's build output, another agent's relayed output) that embeds a valid payload. | **Yes**, once enforcing. The attacker's text cannot contain the nonce. |
| **T3 — pane-resident malicious code.** Code already executing in the pane reads the env like any descendant and emits a correct nonce. | **No. Nothing here helps.** A pane-inherited token cannot distinguish the pane's processes from each other. |

Do not describe this gate as making agent status trustworthy. It makes agent
status *attributable to the pane*, which is a strictly weaker claim.

## Trust tiers

`gradeAgentStatusOscNonce` grades every parsed payload:

- `pane-verified` — nonce present and matched.
- `pane-unattested` — the pane carries a nonce but the payload omitted it, or
  presented a different one.
- `pane-unstamped` — the pane was never stamped (a PTY that predates the
  feature, or a host that does not stamp), so no nonce could be expected.

The tier rides `ProcessedAgentStatusChunk.attestation`, which is in-process
only. It is never persisted, sent over IPC, or published to paired clients — the
nonce itself least of all, since parsed payloads are republished widely.

## Compatibility: why this ships in observe mode

Nothing in this repo emits OSC 9999. **Every payload Orca receives today comes
from an external process**, and the format has never been documented, so the
population of existing self-reporting integrations is unknown rather than known
to be empty. A hard cutover would break all of them silently, and silently is
the operative word: a dropped status row looks like an agent that stopped
reporting, not like a rejected message.

So the default enforcement mode is `observe`:

| Case | `observe` (default) | `enforce` |
|---|---|---|
| Correct nonce | accept, `pane-verified` | accept, `pane-verified` |
| No nonce, pane never stamped | accept, `pane-unstamped` | accept, `pane-unstamped` |
| No nonce, pane **is** stamped | accept, `pane-unattested`, logged | **drop** |
| Wrong or malformed nonce | **drop** | **drop** |

A wrong nonce is dropped in both modes. No integration sends one today, so the
only sources are a replayed capture from a different pane and a deliberate
forgery; there is no compatible behavior to preserve.

`ORCA_AGENT_STATUS_OSC_NONCE=enforce` on the Orca process opts in early.

**Criteria to flip the default to `enforce`:** the
`dropped unattested agent-status OSC payload` warning and its `observe`-mode
counterpart show no sustained `pane-unattested` traffic from real integrations
across a release, and the payload format — including the nonce field — is
documented publicly so integrators have a migration target. Publishing the
format before the gate bites is what turns "an agent could accidentally echo
this" into "anyone can forge this on purpose", so the two must land together.

## Mixed versions

The only wire-visible change is a new optional `nonce` key in the OSC 9999 JSON.
Older parsers drop unknown keys (`normalizeAgentStatusObject` builds an explicit
object), so this is Rule 1 in
[remote-wire-compatibility.md](./remote-wire-compatibility.md) — safe, and safe
only for as long as every reader treats it as optional.

Stamping and verification always happen on the same side: whichever runtime
spawns the PTY stamps its env, and that same runtime's parser checks it. There
is no split where one version stamps and another verifies. A host that does not
stamp reports every payload `pane-unstamped` and behaves exactly as it does
today.

## Where it is wired

- Stamped into pane env wherever `ORCA_PANE_KEY` is (`pty-connection.ts`,
  `launch-worktree-background-terminals.ts`,
  `adopt-agent-background-session-tab.ts`, `codex-detached-pane-restart.ts`), and
  forwarded across the WSL boundary in `wsl-orca-env.ts`.
- Recorded per PTY in `src/main/pty/agent-status-osc-nonce-registry.ts` from the
  spawn env, and dropped with the PTY.
- Checked inside `createAgentStatusOscProcessor`, the one function all four
  parser call sites already share. The call sites keep their separate merge
  points; each supplies its own pane's nonce.
