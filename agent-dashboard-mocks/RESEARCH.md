# How people like to see all their agents at once — research + how it shaped the mocks

Grounded in shipping tools (Warp Agent Panel, herdr, Claude Code Agent View, Claude Squad, uzi, Conductor/Crystal, Vibe Kanban, k9s/Lens, Datadog Host Map, Buildkite, pm2/btop) and notification/triage UX literature. This drives `index.html`.

## The core finding
**"Waiting for input" is the whole reason this view exists.** Everything else is ambient. Every serious tool makes the needs-a-human state the loudest thing on screen and lets you resolve it without a full context switch (Warp "jump to pane", Claude Agent View "reply without attaching"). Practical parallelism tops out around **4–8 agents** (occasionally ~30), so the default should optimize glanceability for a handful, with a density fallback for many.

## Design principles applied to the mocks
1. **Waiting-for-input is loudest.** Amber + gentle pulse, top-of-sort priority, an always-visible aggregate ("2 need you"), a one-line *reason label*, and inline **Answer**/**Open** actions. → the **Needs you** inbox is the purest form; every other view surfaces it too.
2. **State is the primary channel, encoded redundantly.** Color + icon + text label (never color alone — accessibility). Colors map to Orca's `main.css` tokens (success green, destructive red) with a mock-local amber/blue for waiting/working.
3. **Motion = "needs you or is changing," never decoration.** Only *working* (subtle) and *waiting* (pulse) animate; done/idle/error are static. Respects `prefers-reduced-motion`.
4. **Density adapts to count.** Cards (≤8) → table (8–20) → tiles/grid (20+). The switcher lets you feel each.
5. **Group by project with roll-up, but let urgency flatten it.** Gallery/tree group by repo; the inbox is the flat, urgency-sorted triage view.
6. **Per-agent info priority:** state → reason (when blocked) → what it's working on → last activity → elapsed → provider badge → branch. Shown progressively (1–4 always, 5–7 on hover/detail).
7. **Live preview on hover, dots at rest.** Don't mount 30 live xterms (perf) — rest = status; **hover → terminal tail popover** with a jump-in affordance. This is the shared popover in every variant.
8. **Notify on transitions, tiered.** waiting/error = interruptive (toast + unread badge, and Orca's mobile push); done = ambient; working/idle = silent.

## The seven variants ↔ research concepts
| Variant | Maps to | Best for |
|---|---|---|
| **Repo › worktree › agent** (nested, default) | herdr state roll-up; k9s XRay tree; your own idea | Mirrors Orca's real hierarchy; roll-up dot on each repo/worktree tells you if anything inside needs you; agents sorted by urgency |
| **Needs you** (inbox) | Inbox-zero triage; Warp attention state | Any count — the "just tell me what needs me" view |
| **Card gallery** (default) | Conductor/Lens cards + progressive disclosure | Typical 5–12 — best glanceability/info balance |
| **Kanban board** | Vibe Kanban (columns = state) | 8–15; managing rather than co-coding |
| **Mission control** (table) | uzi `ls -w`, k9s | 15–30; terminal-native power users |
| **Terminal wall** (mosaic) | tmux wall, Claude Squad panes | 2–6; comparison runs / ambient monitor |
| **Tree + focus** (master-detail) | k9s XRay tree, Conductor, herdr roll-up | Supervise + dive-in; strong general default |
| **Radial map** | Datadog Host Map / your original concentric dashboard | Stretch/overview concept; homage to the movable-UI branch |

**Recommendation from the research:** ship **Card gallery** as default + **Tree + focus** as the working surface, with **Needs you** as a one-key filter and **Mission control** as the "I have 25 agents" density toggle. Wall/radial are focus/overview modes.

## Sources
Warp [managing-agents](https://docs.warp.dev/agents/using-agents/managing-agents) · herdr [github](https://github.com/ogulcancelik/herdr), [docs](https://herdr.dev/docs/agents/) · Claude Code [agent-teams](https://code.claude.com/docs/en/agent-teams), [Agent View cockpit](https://www.contextstudios.ai/blog/claude-code-agent-view-multi-agent-cockpit) · Claude Squad [github](https://github.com/smtg-ai/claude-squad) · uzi [github](https://github.com/devflowinc/uzi) · Conductor [docs](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions) · Vibe Kanban [github](https://github.com/BloopAI/vibe-kanban) · k9s [site](https://k9scli.io/), [palark](https://palark.com/blog/k9s-the-powerful-terminal-ui-for-kubernetes/) · Datadog [host map](https://docs.datadoghq.com/dashboards/widgets/hostmap/), [widget colors](https://docs.datadoghq.com/dashboards/guide/widget_colors/) · Buildkite [dashboard](https://buildkite.com/docs/pipelines/dashboard-walkthrough) · pm2/btop [monitoring](https://pm2.keymetrics.io/docs/usage/monitoring/) · Triage UX [Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/notifications/), [Missive inbox zero](https://missiveapp.com/blog/inbox-zero)
