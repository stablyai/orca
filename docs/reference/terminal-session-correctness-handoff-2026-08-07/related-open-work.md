# Related GitHub work

This is a curated overlap map, not a merge queue. States were verified against
GitHub on 2026-08-08 UTC and must be refreshed before any rebase, merge, close,
or implementation decision.

Rules:

- Do not stack PRs merely because they appear in the same section.
- “Conflict” means semantic or file overlap that requires one coherent design,
  not an instruction to merge both.
- A related PR can supply diagnosis, tests, or a small reusable primitive
  without becoming a dependency.
- Landing a related PR does not promote G0–G7 or one of the thirteen journeys
  unless the final converged tree passes that gate's complete proof.
- GitHub issue/PR text is context, not authority over the user's goal.

## Immediate incident and competing implementations

- [Issue #11729 — SSH remote environment not restored after login on Rocky Linux
  9.4](https://github.com/stablyai/orca/issues/11729) — **open**. This is the
  named STA-3077 customer incident. Its final acceptance must include Rocky
  Linux SSH, repeated reconnect, the same PID/process/session/transcript
  identity, restored workspace environment, visible pane count, and actual
  remote relay PTY/process count.
- [PR #13111 — stop reconnect grafting panes, stacking leases, and respawning
  live shells](https://github.com/stablyai/orca/pull/13111) — **open**, current
  branch, green checks, no approval. It is narrow containment and leaves remote
  shell reclamation unresolved. One major Docker settle review thread remains
  [unresolved](https://github.com/stablyai/orca/pull/13111#discussion_r3739665033).
- [PR #12264 — stop reconnect from grafting ghost terminal
  panes](https://github.com/stablyai/orca/pull/12264) — **open and conflicting**.
  It targets the same incident and overlaps persistence, PTY, SSH relay, and E2E
  files. Mine its diagnosis and discriminating artifacts; do not stack it
  wholesale with #13111.
- [PR #12743 — contain reattach to existing panes, quarantine
  orphans](https://github.com/stablyai/orca/pull/12743) — **open and
  conflicting**. It shares `mayCreate: false` and broader relay coverage, but
  quarantine must be judged against the no-reconciliation final design.
- [PR #12456 — reattach on `restoreRequired` instead of expiring a live
  session](https://github.com/stablyai/orca/pull/12456) — **open**. It addresses
  the #12448 branch through retry rather than cold respawn. Treat it as a
  semantic alternative or complementary recovery path only after choosing one
  exact restore protocol.
- [PR #9820 — reap orphaned relay PTYs before session-cap
  exhaustion](https://github.com/stablyai/orca/pull/9820) — **open**. Its
  time-based remote kill conflicts with unknown-is-not-dead and #13111's
  deliberate non-kill behavior. Use it as incident evidence, not a safe default
  dependency.
- [PR #12798 — opt-in zmx-backed durable SSH
  terminals](https://github.com/stablyai/orca/pull/12798) — **open**. This is a
  broad architectural alternative for final remote PTY ownership with direct
  file overlap. Evaluate capability-by-capability; never blend it into the
  current model accidentally.

## Open incident issues that should become explicit oracles

- [Issue #9819 — SSH relay leaks orphaned PTYs until the 50-session
  cap](https://github.com/stablyai/orca/issues/9819) — explicit close,
  disconnected close with a lost shutdown response, and worktree teardown must
  durably retry retirement of the exact lease and process. Uncertain sessions
  must survive visibly until resolved. Repeated reconnect must reclaim actual
  relay PIDs/session slots rather than accumulate toward the cap.
- [Issue #9034 — SSH reconnect repeatedly spawns detached PTYs for one
  pane](https://github.com/stablyai/orca/issues/9034) — count actual remote PTYs
  and prove bounded one-pane ownership across repeated reconnect.
- [Issue #11006 — transient SSH disconnect treats live relay PTYs as dead and
  duplicate-respawns agents](https://github.com/stablyai/orca/issues/11006) —
  disconnect with a live process must remain unresolved/reattachable and must
  not start another agent.
- [Issue #12447 — closed SSH tabs resurrect and auto-resume old
  sessions](https://github.com/stablyai/orca/issues/12447) — explicit close must
  persist its pending tombstone before a kill RPC, survive a lost reply plus app
  and relay restart, retry after handshake, reclaim the exact remote PTY, and
  never recreate UI or automatic resume.
- [Issue #12448 — `restoreRequired` is misreported as session
  expiry](https://github.com/stablyai/orca/issues/12448) — source recovery must
  replay/repaint on the same PID and binding without starting a replacement
  `--resume`; identity drift, timeout, or unknown state must not become proof of
  process death or cold resume authority.
- [Issue #12699 — SSH sleeping-agent wake sweep forks live remote
  sessions](https://github.com/stablyai/orca/issues/12699) — all wake/resume
  paths must share the same exact liveness and identity contract.
- [Issue #12683 — remote-runtime disconnect spends recovery on stale same-handle
  reattach](https://github.com/stablyai/orca/issues/12683) — paired/web terminal
  recovery must fence generations and retain automatic liveness.
- [Issue #10208 — duplicate terminal tab on worktree session
  restore](https://github.com/stablyai/orca/issues/10208) — local/worktree
  restore must prove the same pane and process rather than creating a duplicate.

These issues are separate customer-visible symptoms. A single structural model
should make their shared invalid transitions impossible, while each issue keeps
its own discriminating regression journey.

## Daemon, relay generation, and liveness work

The acceptance matrix must also reproduce these open lifecycle incidents:

- [Issue #11904 — tab close with a broken binding orphans the daemon
  session](https://github.com/stablyai/orca/issues/11904) — close intent must be
  durable before transport work and eventually retire the exact process.
- [Issue #8585 — detached relay generations are never
  reaped](https://github.com/stablyai/orca/issues/8585) — termination must name
  the exact relay generation; path/PID reuse or a failed connection cannot kill
  a successor.
- [Issue #9138 — updates leave old daemon generations and sessions
  alive](https://github.com/stablyai/orca/issues/9138) and
  [issue #11342 — stale daemon/PTY generations leak across upgrade and
  close](https://github.com/stablyai/orca/issues/11342) — upgrade must converge
  without invisible sessions, guessed ownership, or unbounded retention.
- [Issue #10415 — Windows daemon crash on unkillable PTY and protocol
  bump](https://github.com/stablyai/orca/issues/10415) — native Windows must
  preserve live old-generation sessions or expose exact unresolved recovery;
  one unkillable PTY cannot crash the daemon.
- [Issue #8275 — worktree teardown kills unrelated split-pane
  sessions](https://github.com/stablyai/orca/issues/8275) — teardown and failure
  must remain exact-namespace/exact-binding scoped.

- [PR #12882 — publisher-owned daemon endpoint
  replacement](https://github.com/stablyai/orca/pull/12882) — **open and
  mergeable** when checked. It provides single-writer endpoint publication and
  three-valued liveness. Reconcile it before editing overlapping daemon paths;
  do not assume the older handoff's merge order is still current.
- [PR #11622 — fence daemon session ownership across
  generations](https://github.com/stablyai/orca/pull/11622) — **open** and held
  behind further audit per its description. Strong explicit
  owned/unavailable/ambiguous semantics, but broad overlap makes it design input,
  not an automatic dependency.
- [PR #9833 — report local PTY inventory
  readiness](https://github.com/stablyai/orca/pull/9833) — **open**. Its
  pending/ready/stale distinction is reusable context for unknown-is-not-dead.
- [PR #12760 — reap only the proven relay
  generation](https://github.com/stablyai/orca/pull/12760) — **open**. It adds
  exact relay generation ownership before termination and conflicts in
  `ssh-relay-session.ts`; reconcile before designing remote shell cleanup.
- [PR #8618 — reap a detached relay after failed
  reconnect](https://github.com/stablyai/orca/pull/8618) — **open** and an older
  competing predecessor to #12760. Do not combine both ownership schemes.
- [PR #12749 — wait for a disconnected PTY owner's full
  grace](https://github.com/stablyai/orca/pull/12749) — **open**. Useful owner
  admission and grace context; timers may schedule retry but cannot independently
  authorize takeover or destruction.
- [PR #12702 — stop sleeping-agent wake sweep from forking live SSH
  sessions](https://github.com/stablyai/orca/pull/12702) — **open**. Complementary
  #12699 work that must converge on the same ownership/liveness behavior; it
  need not share an internal primitive unless the reconciled design calls for
  one.
- [PR #10118 — durable persistence write
  seam](https://github.com/stablyai/orca/pull/10118) — **open**. It overlaps
  `persistence.ts` and is relevant to durability and main-thread performance;
  reconcile before large persistence changes.

## Paired runtime, remote server, and E2EE lifecycle work

These open issues are mandatory inputs to the paired/remote/platform journeys:

- [Issue #11495 — paired viewer loses attachments across update/restart while
  host PTYs remain alive](https://github.com/stablyai/orca/issues/11495) — the
  reported large host population is a strong restore/scale oracle; each pane
  must return to the same host PTY/process.
- [Issue #11265 — paired terminals stall despite live TCP
  sockets](https://github.com/stablyai/orca/issues/11265) — transport connectivity
  is not delivery liveness; recovery must resume output without an unrelated RPC
  kick.
- [Issue #11803 — remote stop respawns tabs from a stale
  owner](https://github.com/stablyai/orca/issues/11803) — exact durable retirement
  must remain retired after host/client restart.
- [Issue #12241 — paired-host session partitions grow without
  bound](https://github.com/stablyai/orca/issues/12241) — paired and scale
  journeys must prove bounded state and safe lost-consumer
  retirement/compaction liveness.
- [Issue #11574 — same-server re-pairing changes host identity and strands
  sessions](https://github.com/stablyai/orca/issues/11574) — stable final-host
  identity must survive re-pairing without adopting another host.
- [Issue #9827 — investigate WSL session
  restoration](https://github.com/stablyai/orca/issues/9827) and
  [issue #11339 — WSL commands are not restored after
  restart](https://github.com/stablyai/orca/issues/11339) — the daemon/WSL
  journey must run on physical WSL and preserve both shell commands and agent
  sessions.

Additional open incident inputs must be triaged into a named journey or ruled
unrelated with explicit evidence and user acceptance:

| Issue                                                                                                       | Required question                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [#11800 — paired null-PTY terminal ghosts](https://github.com/stablyai/orca/issues/11800)                   | Does host topology advancement retire exact placeholders without inference or a permanent timer reconciler? |
| [#9092 — remote runtime fails after macOS sleep](https://github.com/stablyai/orca/issues/9092)              | Does generation-fenced reconnect recover after sleep with bounded resources and no identity change?         |
| [#9585 — remote ghost tabs after host restart](https://github.com/stablyai/orca/issues/9585)                | Are exit/retirement outcomes durable and idempotent across host restart?                                    |
| [#9562 — remote host session restarts empty](https://github.com/stablyai/orca/issues/9562)                  | Does the complete boundary plus replay restore terminal state after server restart?                         |
| [#12568 — no PTY provider after SSH relay recovery/update](https://github.com/stablyai/orca/issues/12568)   | Does lazy rediscovery restore the exact host/provider generation?                                           |
| [#10385 — mobile remains falsely connected after RPC stalls](https://github.com/stablyai/orca/issues/10385) | Can E2EE/mobile liveness recover when transport looks connected but RPC is stalled?                         |
| [#12140 — mobile pairing socket closes immediately](https://github.com/stablyai/orca/issues/12140)          | Do capability, identity, and E2EE negotiation fail explicitly and recover across LAN/Tailscale?             |
| [#8129 — mobile events lost while disconnected](https://github.com/stablyai/orca/issues/8129)               | Are semantic outcomes durable and replayed to a disconnected/backgrounded consumer?                         |

- [PR #11575 — preserve host identity across same-server
  re-pairing](https://github.com/stablyai/orca/pull/11575) — **open**. Direct
  identity context for the paired reconnect journey.
- [PR #12768 — restore paired snapshots at the source
  grid](https://github.com/stablyai/orca/pull/12768) — **open**. Complementary
  host-snapshot authority work with renderer file overlap.
- [PR #9093 — recover remote runtime streams after client
  wake](https://github.com/stablyai/orca/pull/9093) — **open**. Provides
  generation-cancelled bounded-backoff reconnect context.
- [PR #10235 — self-heal remote subscriptions after server
  restart](https://github.com/stablyai/orca/pull/10235) — **open**. Relevant to
  E2EE session loss hidden by a live relay transport.
- [PR #11596 — recover falsely connected mobile RPC
  sessions](https://github.com/stablyai/orca/pull/11596) — **open and
  conflicting**. Broad mobile/E2EE reconnect context; do not absorb its parallel
  lifecycle machinery without a full state-machine audit.
- [PR #12036 — stop blocking E2EE handshake on synchronous ACL
  writes](https://github.com/stablyai/orca/pull/12036) — **open and conflicting**.
  Preserve its metadata-versus-correctness durability distinction and measured
  Windows performance constraint during identity lifecycle work.
- [PR #12134 — refresh stale capabilities before
  pairing](https://github.com/stablyai/orca/pull/12134) — **open**. Capability
  freshness and reauthentication are required mixed-version/pairing context.
- [PR #11804 — make remote stop retirement
  durable](https://github.com/stablyai/orca/pull/11804) — **open**. Strong
  complementary evidence for exact persisted owner routing and host-side
  retirement acknowledgement.
- [PR #12987 — distinguish an absent worktree from an empty tab
  list](https://github.com/stablyai/orca/pull/12987) — **open**. Reusable
  unknown-versus-authoritative-empty semantics.
- [PR #12751 — preserve tabs when a snapshot reports
  none](https://github.com/stablyai/orca/pull/12751) — **open** and a competing
  less-exact alternative to #12987; its described multi-client non-convergence
  must not become the final model.
- [PR #12339 — stop remote workspace pulls from resurrecting closed
  tabs](https://github.com/stablyai/orca/pull/12339) — **open**. Direct topology
  reconciliation context for explicit close and stale snapshots.
- [PR #13013 — stop stale snapshot applies from erasing fresh terminal
  tabs](https://github.com/stablyai/orca/pull/13013) — **open**. Relevant legacy
  snapshot race; decide whether its machinery is deleted by the final authority
  cutover rather than layering another permanent reconciler.
- [PR #12903 — retry snapshot tabs whose paths resolve after
  apply](https://github.com/stablyai/orca/pull/12903) — **open**. Deferred
  hydration is relevant legacy-importer context and may become deletable after
  authoritative namespace resolution; do not retain it by default.

## Delivery, backpressure, and lifecycle alternatives

- [Draft PR #12220 — keep SSH alive when a terminal outruns a slow
  link](https://github.com/stablyai/orca/pull/12220) — **open draft**. Useful G3
  and performance evidence, but its own description has behavioral blockers and
  a stalled-consumer wedge. Do not treat it as merge-ready.
- [PR #10744 — durable lost-worker archive and mixed-version SSH
  revive](https://github.com/stablyai/orca/pull/10744) — **open** and broad. It
  is major architectural context for exact close, outcomes, retirement, and
  mixed versions, with substantial overlap. Mine proof and semantics rather
  than stacking blindly.
- [PR #11801 — prune stale remote tab
  ghosts](https://github.com/stablyai/orca/pull/11801) — **open**. Its snapshot
  omission plus timer policy is relevant but may conflict with the rule that
  absence/time alone cannot prove destructive cleanup.

## Mandatory issue-to-journey matrix

This table binds customer incidents to the thirteen journeys in
[`goalposts.md`](./goalposts.md#thirteen-required-production-journeys). Closing
an issue or merging a narrow PR does not remove its oracle. Each row must be red
on an unfixed baseline and green on the final candidate, or the user must accept
explicit evidence that the issue is unrelated.

| Open issue(s)                                                                                                                                                             | Journey(s)       | Mandatory discriminating outcome                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [#11729](https://github.com/stablyai/orca/issues/11729)                                                                                                                   | 6, 9, 13         | Rocky Linux reconnect preserves the same workspace, transcript, pane, binding, PID, and environment without PTY growth.                        |
| [#9819](https://github.com/stablyai/orca/issues/9819), [#9034](https://github.com/stablyai/orca/issues/9034)                                                              | 6, 13            | Reconnect cannot accumulate detached PTYs/session slots; explicit close and teardown reclaim the exact process, including lost-response retry. |
| [#11006](https://github.com/stablyai/orca/issues/11006), [#12448](https://github.com/stablyai/orca/issues/12448), [#12699](https://github.com/stablyai/orca/issues/12699) | 2, 6             | Disconnect, source recovery, and wake keep the same live PID/session and never start a duplicate resume without proof of death.                |
| [#12447](https://github.com/stablyai/orca/issues/12447), [#11904](https://github.com/stablyai/orca/issues/11904)                                                          | 2, 6             | Durable close intent survives lost RPC, app/daemon/relay restart, retries exact retirement, reclaims the process, and never resurrects UI.     |
| [#10208](https://github.com/stablyai/orca/issues/10208)                                                                                                                   | 1, 9             | Worktree switch/restore preserves one exact pane/process and does not duplicate a tab.                                                         |
| [#8585](https://github.com/stablyai/orca/issues/8585)                                                                                                                     | 2, 6, 12         | Cleanup affects only the proven relay generation across reconnect and version change; ID/path reuse cannot kill a successor.                   |
| [#9138](https://github.com/stablyai/orca/issues/9138), [#11342](https://github.com/stablyai/orca/issues/11342)                                                            | 2, 12, 13        | Upgrade/restart converges old daemon generations and their PTYs without invisible sessions, leaks, or destructive guessing.                    |
| [#8275](https://github.com/stablyai/orca/issues/8275)                                                                                                                     | 1, 2, 5          | Worktree teardown cannot terminate a sibling namespace or split-pane session.                                                                  |
| [#10415](https://github.com/stablyai/orca/issues/10415)                                                                                                                   | 1, 2, 5, 12      | Native Windows handles an unkillable PTY and protocol bump without daemon crash, live-session loss, or cross-session damage.                   |
| [#9827](https://github.com/stablyai/orca/issues/9827), [#11339](https://github.com/stablyai/orca/issues/11339)                                                            | 2, 9             | Physical WSL restart restores the same shell command and agent session under the exact namespace/binding.                                      |
| [#12568](https://github.com/stablyai/orca/issues/12568)                                                                                                                   | 3, 6, 12         | Relay recovery/update lazily rediscovers the same SSH host/provider and restores only its exact sessions.                                      |
| [#11495](https://github.com/stablyai/orca/issues/11495), [#11574](https://github.com/stablyai/orca/issues/11574)                                                          | 4, 8, 10, 12, 13 | Paired restart/re-pair preserves stable host identity and every reported live host PTY at scale across independent updates.                    |
| [#11265](https://github.com/stablyai/orca/issues/11265), [#9092](https://github.com/stablyai/orca/issues/9092)                                                            | 8, 13            | Live-but-stalled transport and sleep/wake automatically resume bounded delivery without an unrelated RPC kick or identity replacement.         |
| [#11803](https://github.com/stablyai/orca/issues/11803), [#9585](https://github.com/stablyai/orca/issues/9585), [#11800](https://github.com/stablyai/orca/issues/11800)   | 3, 8             | Remote stop/host topology outcome remains durably retired after restart; no stale-owner tab or null-PTY ghost returns.                         |
| [#9562](https://github.com/stablyai/orca/issues/9562), [#8129](https://github.com/stablyai/orca/issues/8129)                                                              | 3, 8, 13         | Complete boundary plus replay restores disconnected/restarted consumers without an empty session or lost semantic outcome.                     |
| [#12241](https://github.com/stablyai/orca/issues/12241)                                                                                                                   | 8, 11, 13        | Paired partitions and retained-consumer state remain bounded; lost-consumer retirement safely restores compaction liveness.                    |
| [#12683](https://github.com/stablyai/orca/issues/12683)                                                                                                                   | 8, 12            | Stale same-handle reconnect is generation-fenced and automatic recovery remains live across independent peer versions.                         |
| [#10385](https://github.com/stablyai/orca/issues/10385), [#12140](https://github.com/stablyai/orca/issues/12140)                                                          | 8, 10, 12        | False-connected or rejected E2EE/pairing state fails explicitly and reauthenticates without stale identity, capability, or session adoption.   |

Journeys 4, 5, 7, 10, and 11 remain mandatory even where no single issue fully
specifies them. This matrix adds incident oracles; it never narrows the journey
definitions.

## Original containment/refactor line

- [PR #12600 — break Activity and terminal React 185
  loops](https://github.com/stablyai/orca/pull/12600) — **merged**. It is current
  containment/background context, not the whole program and not a release gate.
- [PR #12634 — replace React 185 timers with structural
  handoffs](https://github.com/stablyai/orca/pull/12634) — **open**. This is the
  direct structural follow-up for deleting #12600's window/timer brakes and must
  be reconciled with the broader terminal-session model.
- [PR #13110 — sandboxed preload artifact
  guard](https://github.com/stablyai/orca/pull/13110) — **open**, independent of
  #13111, green at its head, no approval. Its unresolved major review says raw
  source matching can reject safe strings/comments; resolve or supersede that
  [finding](https://github.com/stablyai/orca/pull/13110#discussion_r3739646949)
  before calling it ready.

## Already merged base context

These were described as open in older notes but were merged when this handoff
was written:

- [PR #12474 — isolate same-path folder workspace PTY
  identity](https://github.com/stablyai/orca/pull/12474)
- [PR #12477 — stop a closed remote workspace window reading
  Ready](https://github.com/stablyai/orca/pull/12477)
- [PR #12600 — React/terminal loop containment](https://github.com/stablyai/orca/pull/12600)

Refresh `main` and recalculate conflicts; do not follow the stale sequence
`#12882 → #12474 → #12477 → #13111` as written.

## Required GitHub refresh before action

At minimum, re-query:

```bash
gh pr view 13111 --repo stablyai/orca --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,url
gh pr view 13110 --repo stablyai/orca --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,url
gh issue view 11729 --repo stablyai/orca --json state,title,updatedAt,url
```

Refresh the complete catalog in one batched request:

```bash
handoff_query_text="$(tr '\n' ' ' < docs/reference/terminal-session-correctness-handoff-2026-08-07/github-overlap-query.graphql)"
gh api graphql -f query="$handoff_query_text"
```

The query includes current PR state/check summaries and unresolved-thread state
for #13110/#13111. Read PR bodies/diffs only for the slice being changed. Do not
close, comment, merge, push, or checkout a PR from the handoff audit without
explicit authorization.
