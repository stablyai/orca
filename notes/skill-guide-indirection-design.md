# Skill Guide Indirection (Thin Stubs + `orca skills get`)

Status: FOLDED INTO `skill-freshness-design.md` (2026-07-13) — read that instead. The stub/CLI
contract and prior-art survey carried over; the migration-via-in-app-updater section here is
superseded (migration now rides `npx skills update`, no in-app writes).

## Principle

Version-sensitive content must not live in distributed files; only discovery metadata should.
Every hard problem in the current system — staleness, adoption consent, installer attribution,
transactional replacement, remote-host reconciliation — descends from shipping full skill
bodies as mutable files that must track the installed Orca binary. Move the bodies into the
binary and the problems shrink to a residue the existing machinery already handles.

## Design

### 1. The binary serves the instructions

New CLI surface (topic names match skill names):

```sh
orca skills list                 # enumerate available guides, one line each
orca skills get <topic>          # full version-matched guide for one skill, markdown to stdout
orca skills get <topic> --full   # include bundled reference docs, if any
```

- Content is authored in `skill-guides/<topic>.md`. A generator embeds those authoritative
  sources in the CLI and emits `skills/<name>/SKILL.md` as an installable projection;
  `skills/` is generated output, not an authoring source.
- Output contract: plain markdown on stdout, exit 0; unknown topic exits nonzero with the
  topic list. No network, no filesystem reads outside the binary's own resources.
- Verb choice: `skills get` (not `guide`) to match the convention agents are already being
  taught by other tools (see Prior art).

### 2. Historical stub sketch (superseded; do not copy)

This sketch records the indirection idea only. The resolver and first-generation hybrid stub
contract in `skill-freshness-design.md` are authoritative and must cover packaged `orca`,
Linux/WSL `orca-ide`, SSH `orca`, and development `orca-dev` without blindly invoking bare
`orca` on Linux.

```markdown
---
name: orca-cli
description: <unchanged per-skill trigger copy — this is the discovery surface>
allowed-tools: <all supported Orca CLI command names>
---

# Orca CLI

This file is a discovery stub, not the usage guide. The full, version-matched reference
lives in the `orca` binary itself.

Before using Orca commands, resolve the CLI for this session and load the guide once:

    <resolved-orca-cli> skills get orca-cli

Don't guess subcommands or flags from memory or from cached copies of this skill — they
change between Orca releases; the command above always matches the installed binary.
```

Stub rules:
- Body is deliberately version-independent: it says when to engage Orca and where to fetch
  the how — never the how itself. A stub should survive many releases unchanged.
- `allowed-tools` must cover every executable that the authoritative resolver can select.
- Stub must not ship before the binary that serves its topic: gate stub rollout on the
  release that includes `skills get` (a stub pointing at a command that does not exist
  is worse than a fat skill). Enforce with a build check: every stub topic must resolve
  against the compiled guide table.
- Stub should degrade honestly when no supported Orca command is on PATH and must retain a
  bounded legacy bootstrap for binaries that predate `skills get`.

### 3. What this retires, what it keeps

Retired / collapsed:
- The ownership ledger, adoption and installer-attribution flows, background updater,
  transactional publish/rollback/orphan sweep, and all automatic writes into user-owned
  skill directories.
- Phases 3–4 of skill-auto-update-design.md (WSL/SSH remote file reconcilers). Wherever the
  skill is useful the `orca` binary is present, and the remote binary serves the guide
  matching its own host's version. No remote file-sync problem remains.

Kept (read-only):
- Bounded discovery, LF-normalized content identities, the released-snapshot registry,
  release mapping, and CI gates. Statuses are `current`, `outdated`, `newer-known`,
  `unrecognized`, and `inaccessible`; no ledger is needed to compute them.
- Name-scoped eligibility across every placement. One newer, unrecognized, external,
  read-only, repo-scoped, plugin, or inaccessible placement poisons the update offer for
  that skill name.
- The skills-CLI round-trip CI, extended to prove historical fat installs migrate to stubs
  through targeted global updates across supported hosts and topologies.
- Read-only settings rows and a dismissible nudge that pre-fill a targeted
  `npx skills update <eligible-names...> --global` command. Orca never submits it or writes
  into a skill directory.

## Prior art (verified live 2026-07-13)

- vercel-labs/agent-browser — canonical stub + `agent-browser skills get core`; docs frame
  it explicitly: "the installed SKILL.md rarely changes, while the CLI always serves content
  matching its own version." Stub self-describes as a discovery stub that "cannot change
  between releases."
- Canner/WrenAI (skills/wren/SKILL.md) — independent (non-Vercel) adopter: "The actual
  workflow guides … live inside the `wren` CLI itself, so they always match the installed
  wrenai version (no skill cache, no version drift)." Uses `wren skills list` /
  `wren skills get <topic>` / `--full` — the verb convention to match.
- vercel-labs/zerolang (skills/zero/SKILL.md) — "This file is only a discovery stub… ask the
  installed compiler for the skill content that matches that exact binary." Adds the nuance
  of warning agents not to replace a pinned binary.
- vercel/next.js (skills/next-dev-loop/SKILL.md) — consumes the pattern: instructs agents to
  "run `agent-browser skills get core` once for the version-matched usage guide — don't
  guess subcommands from memory." Normalization signal.
- Ecosystem discourse (Snyk threat model, HN, vercel-labs/skills issues #500/#542, Anthropic
  skill-trust guidance) demands pinning + reviewable updates and condemns silent pulls from
  mutable remotes. Stub indirection satisfies the audit-once trust model: the audited file
  never changes meaning; served content is exactly as trusted as the installed binary.

## Migration plan

0. Release `orca skills list/get` first from authoritative `skill-guides/` sources while
   distributed skills remain fat. No stub may reach repository main before a public binary
   can serve it.
1. Add read-only freshness detection, name-scoped update eligibility, the targeted
   user-invoked `npx skills update <names...> --global` action, and migration-rail CI. Keep
   distributed skills fat.
2. Spike pointer compliance against the released guide-serving binary with Claude Code and
   Codex, including Linux/WSL/SSH/dev command resolution, old-binary fallback, task success,
   and token cost.
3. Convert only `orca-cli` to a first-generation hybrid stub. Existing exact official fat
   copies become eligible for the targeted ecosystem update rail; users who ignore the
   nudge retain their existing skills.
4. Cut an RC, measure the gates, and thin the hybrid only if it passes. Convert remaining
   skills gradually in later PRs.

## Open questions

- Compliance failure mode: if agents skim the stub and skip the fetch, options are stronger
  stub wording, frontmatter `description` nudging ("requires running orca skills get"),
  or hybrid stubs carrying a minimal command table plus the pointer. Spike decides.
- Multi-file skills: current shipped packages are single-file; if a future skill needs
  scripts/assets, decide whether the binary serves them (`--script <name>` like WrenAI) or
  they stay in the package (then that skill keeps the fat-update path).
- Topic/verb naming: `orca skills get` collides conceptually with the `skills` installer
  CLI; confirm no confusion in agent behavior during the spike.
- Old binaries: a user can hold a stub while running an older orca without `skills get`
  (downgrade case). Stub wording should fail gracefully ("if the command is missing, update
  Orca"); acceptable residual.
- Whether settings should surface "guide served by binary" as a distinct row state so
  support can tell stub-era installs from fat-era ones at a glance.
