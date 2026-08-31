# SSH Execution Boundary

How Orca splits work between your machine and an SSH host, what survives a disconnect, and how to keep `unverifiable` distinct from `exited`. Nothing under `docs/` stated this before; agents and humans were inferring it from error strings and getting it wrong.

## The rule

**The execution host owns everything that touches execution** — tools, credentials, identity, environment, processes, and artifacts. The client owns the UI, transport, and Orca control-plane state, but is not authoritative for execution state.

Two consequences, both non-negotiable:

1. **No silent substitution.** An operation on a remote `repoPath` must never fall back to running on the client. A missing SSH provider is not permission to answer locally — a local run can answer for the _wrong repository_.
2. **No asserting what you cannot observe.** Loss of contact is not evidence of `exited`. Report `unverifiable`, never `exited`.

The vocabulary is fixed: **`live` / `unverifiable` / `exited`**, taken from the incumbent `UnstoppedPtyVerdict`. Do not introduce synonyms, and never collapse `unverifiable` into either neighbour. `exited` requires positive evidence of absence from the host that owns the process; a transport failure can only ever produce `unverifiable`.

Rule 1 is stated at `src/main/source-control/repo-default-branch.ts:76-78`, `src/main/repo-worktrees.ts:45-48`, `OrcaRuntimeService.probeWorktreeDrift` in `src/main/runtime/orca-runtime.ts`, and `src/renderer/src/lib/connection-context.ts:22-24`. It is enforced throughout `src/main/runtime/orca-runtime-git.ts` by the guard that throws `SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE` whenever `target.connectionId` is set and no provider is registered — grep that constant for the current call sites rather than trusting a count.

`src/main/runtime/unstopped-pty-verification.ts:12-16` is the reference implementation of rule 2: it keeps `live` / `unverifiable` / `exited` as three distinct verdicts, and treats "we could not ask" as its own answer.

## What runs where

| Concern                                                        | Executes on        | Notes                                                                |
| -------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| PTYs, agent CLIs                                               | **remote**         | children of the detached relay daemon, not of the ssh channel        |
| git (status, diff, log, fetch, push, commit, branch, worktree) | **remote**         | via `src/relay/git-handler.ts`                                       |
| filesystem, watching, search                                   | **remote**         |                                                                      |
| repo setup hooks (`--setup`)                                   | **remote**         | identical policy to local                                            |
| commit-message / PR-field AI generation                        | **remote**         | uses the remote agent CLI and its auth                               |
| `gh` / GitHub API, `glab` / GitLab                             | **client**         | inconsistent with the rule; PRs carry the client's identity          |
| the `orca` CLI inside a remote terminal                        | **client runtime** | control plane only — your files and processes stay remote; see below |

## Survival: what a disconnect does _not_ do

By default, remote work survives your machine going away. The relay is a detached daemon (`nohup … </dev/null &`), its handler in `src/relay/relay.ts` ignores `SIGHUP`, the PTY is its child rather than the ssh channel's, and quitting Orca is a **detach, not a dispose** (`src/main/ssh/ssh-relay-session.ts:901-915`). Sleep additionally pushes `graceTimeSeconds: 0` to un-bound any running grace window.

Two ways remote work _can_ actually stop:

- **A bounded grace period.** The shipped default is `0` = keep alive until reset. If "keep terminals alive until reset" is unchecked, the configurable range is **60s–7d** and the form defaults to **24h**. The countdown starts when the client disconnects, after which the relay SIGKILLs every PTY. Note the asymmetry: sleep protects you, but ordinary disconnect and app quit do not. No command reports which setting is in effect for a target, so at N hours since disconnect you cannot tell "unlimited" from "24h with 7 left" — treat the remote as `unverifiable`, not `exited`.
- **Host-acknowledged explicit user action** — End Remote Terminals, Reset Relay, removing the target, or closing the tab. When the host cannot acknowledge the request, closing a tab or removing a target may clear only client state; the remote verdict remains `unverifiable`.

Reconnect re-attaches to the same live PTYs and replays a bounded buffer (`REPLAY_BUFFER_MAX`, a 102,400-code-unit tail). Output beyond that while you were away is lost to the client even though the process was never interrupted: **the transcript is truncated; the work stays `live`.**

## Control plane

On an SSH host, `orca` is a shim (`~/.orca-relay/bin/orca`) that proxies **back to the client's runtime** over the relay socket. Your repository, processes, and files remain remote — only the control plane is on the client. This is correct for an SSH target, but it has a consequence worth stating plainly:

> When the client disconnects, every `orca …` command run on the SSH host fails with `No owning Orca client is connected to the relay`. The PTY stays `live`; its control plane does not.

Orchestration state (Runs, Tasks, Dispatches, mailboxes) is client-resident for the same reason. An agent on an SSH host should not depend on `orca` for anything it must finish while you are away. **Commit and push early** — unpushed work on a remote box is unavailable to the client until it reconnects.

## Distinguishing `unverifiable` from `exited`

A verdict needs evidence from the host that owns the process. Apply these tests in order.

**Was the signal produced by the owning host, or by the client's own bookkeeping?** Absence from a client-side set, a lookup that threw, a socket that closed, a command that timed out — none of these observe the process. They are `unverifiable` by construction, whatever the field is named.

**Did every remote PTY on that target go quiet at once?** A transport drop takes them all together. Simultaneous silence across a host indicates a lost link, not simultaneous death.

**Does the termination event match the current identity?** A host-delivered exit for the live PTY incarnation and provider generation, while its siblings still report, establishes `exited`. A stale event, an event for a superseded incarnation, or one quiet terminal with no host evidence does not.

**Is a returned status actually a claim of success?** An operation that reports failure may have succeeded, and one that reports success may not have run — check the durable state it should have changed rather than trusting the return.

Anything short of positive host evidence is `unverifiable`. Reporting it as `exited` is the error this document exists to prevent: it orphans live work and can cold-start a duplicate over the same worktree.

## Reading artifacts instead of process state

Artifacts are stronger evidence than liveness signals, but they answer a narrower question than they appear to.

A matching commit from `git ls-remote --heads origin <branch>` or a PR head lookup proves **that commit reached the remote** — not that the current run pushed it, and not that the latest work was included. An absent result proves nothing was found, not that nothing was pushed: the ref may have been deleted, the PR closed, or the query may simply have failed.

A listing is only evidence about the hosts it actually covered. When a result does not name its scope, an empty answer is not evidence that nothing is running elsewhere. A clean **local** worktree says nothing at all about the remote one.

## One host, one model

An SSH host and a paired runtime (`orca environment`) imply opposite boundaries: the first is a dumb execution host driven by your client, the second is a peer that owns its own control plane. Registering the same machine both ways splits its worktrees across two identities, makes `terminal list` return different sets depending on `--environment`, and reliably confuses both humans and agents. Pick one per machine.

For work that must continue while you are offline, use the peer/headless-runtime model on the remote host instead of the direct-SSH model. Its control plane is host-local, and its daemon-backed PTYs stay `live` across a normal runtime restart so the runtime can reattach; an explicit daemon shutdown can still make them `exited`. Do not register the same machine through both models. A detached agent process outside Orca can also survive a control-plane outage, but it has no stdin, so its instructions cannot be amended mid-run.
