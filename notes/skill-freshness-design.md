# Skill Freshness: Thin Stubs + Read-Only Detection

Status: adopted direction 2026-07-13. Phase 1 (guide sources + binary-served CLI) is
implemented, pending release; detection and stub migration are not implemented. This is the
authoritative plan. It supersedes the write phases of `skill-auto-update-design.md` (Phases
2–4: background updates, WSL, SSH) and the migration section of
`skill-guide-indirection-design.md`. The detection and content-identity research in those
notes still applies and is referenced below.

## Problem (unchanged)

Orca ships agent skills that teach coding agents to drive the `orca` CLI. Users install them
with `npx skills add stablyai/orca --global`. Installed copies are frozen files; the Orca
binary keeps moving. A stale skill tells an agent to use commands that are wrong or unsafe
for the binary it is driving.

## Decision

Three moves, replacing the in-app write machinery entirely:

1. **Structural fix — content lives in the binary.** All version-sensitive skill content is
   served by the CLI (`orca skills get <topic>`), compiled at build time from authoritative
   `skill-guides/` sources. Generated `skills/<name>/SKILL.md` files are the installable
   discovery surface and become permanent thin stubs. Staleness becomes impossible for the
   content that matters, rather than mitigated.
2. **Residual freshness — read-only detection, ecosystem-rail updates.** Orca detects
   outdated official copies (content-addressed, LF-normalized identity) and pre-fills a
   targeted `npx skills update <names...> --global` command in a terminal. The user reviews
   and runs the skills CLI's own update command; Orca never submits it automatically and
   never writes a byte into a skill directory.
3. **No persistent ownership or update state.** No ownership ledger, no adoption consent,
   no background writer, no transactional publish/rollback stack, no settings toggle. The
   one content migration (fat skill → stub) rides the same user-invoked npx rail. A small
   dismissed-nudge set remains in app state; it grants no write authority.

### Why the write machinery was dropped (decision record)

- **Maintenance-per-use.** The transactional mutation stack (staging, rollback, crash
  recovery, orphan sweeping, ownership ledger, installer attribution) is ~3.2K production
  lines before its tests. It is the most correctness-critical code in the tree, built to
  write into user-owned directories forever. Under the stub model it would run meaningfully
  once. Every module is permanent Windows/WSL/SSH edge-case surface for a one-shot job.
- **Trust posture.** Ecosystem discourse (2026) consistently favors pinning and reviewable,
  user-invoked updates over silent writes into `$HOME`; Orca has first-hand precedent of
  user backlash from writing into user-owned config directories. Read-only detection has no
  trust cost at all.
- **The rail already exists.** `npx skills update <names...> --global` is the ecosystem's
  documented remedy, and once `skills/` contains stubs it delivers the migration without an
  Orca-owned writer. The rail is treated as an external dependency with a tested contract,
  not assumed trustworthy from its lock file alone.
- The full write implementation exists, reviewed and green, on branch
  `brennanb2025/skill-auto-update-research` (PR #8496, closed as superseded). If in-app
  writes are ever genuinely needed, start from that branch, not from scratch.

## Design

### A. Binary-served guides

```sh
orca skills list                 # one line per topic: name + when to use
orca skills get <topic>          # full version-matched guide, markdown to stdout
orca skills get <topic> --full   # include bundled reference docs, if any
```

- Topics are the skill names (orca-cli, orchestration, computer-use, …).
- Full version-sensitive content lives in `skill-guides/<topic>.md`. A generator embeds it
  in a concrete CLI module and emits the installable `skills/<name>/SKILL.md` projection.
  During the pre-stub release this projection may remain fat; after migration it is a stub.
- The generated-output-current check uses the existing generated-artifact-gate pattern used
  by the manifest verifier. It asserts that generated guide data and installable projections
  match their sources and that every stub topic resolves against the compiled guide table.
  No network or runtime filesystem lookup is required. Unknown topic → nonzero exit + topic
  list.
- Authoritative guides, generated projections, and embedded TypeScript are pinned to LF, and
  the generator normalizes input before embedding it. Detection still normalizes text identity
  because already-installed Windows copies may retain the historical CRLF shape.
- Topic names are append-only and aliased forever: a stub installed in 2026 must still
  resolve in 2028. Renames add an alias, never remove one.
- Verb is `skills get` (not `guide`) to match the convention agents are already taught by
  other tools in the wild.

### B. Stub format and command resolution

One stub per skill — frontmatter descriptions are the agent-routing layer and stay
per-skill registry entries.

```markdown
---
name: orca-cli
description: <unchanged per-skill trigger copy — the discovery surface>
allowed-tools: <the supported Orca CLI command names>
---

# Orca CLI

This file is a discovery stub, not the usage guide. The full, version-matched reference
lives in the `orca` binary itself.

Before using Orca commands, resolve the Orca CLI for this session and load the guide once:

    <resolved-orca-cli> skills get orca-cli

Don't guess subcommands or flags from memory or from cached copies of this skill — they
change between Orca releases; the command above always matches the installed binary that
will handle subsequent Orca commands.
```

Rules:

- The permanent body says when to engage Orca, how to resolve its CLI, and where to fetch
  the version-matched guide. It does not carry the changing command reference.
- A stub must never blindly invoke bare `orca` outside an Orca-managed terminal on Linux;
  that name commonly resolves to the GNOME Orca screen reader. The contract must cover
  packaged `orca`, Linux/WSL `orca-ide`, SSH relay `orca`, and development `orca-dev`, and
  `allowed-tools` must cover every command the resolution contract can select.
- **Linux command decision (2026-07-13):** do not install a uniform global bare `orca` alias;
  it would shadow or risk launching the GNOME Orca screen reader. Keep `orca-ide` outside
  managed Linux terminals, the existing managed-terminal/SSH `orca` shims, and `orca-dev` for
  development. The permanent stub therefore needs the short resolver exercised by the spike.
- First-generation stubs are hybrid: a minimal safe bootstrap plus the guide pointer. Thin
  them further only after pointer compliance and old-binary behavior are measured. If
  `skills get` is unavailable, the hybrid must provide a bounded legacy workflow and tell the
  user that updating Orca restores the full version-matched guide; it must not dead-end or
  invite the agent to guess the missing command surface.

### C. Read-only detection (kept from Phase 1, slimmed)

Kept as-is:
- Bundled `skills/` packages + current manifest + released-snapshot registry + release
  mapping, with the generation script and merge-queue monotonicity gate (static data + CI,
  not runtime machinery).
- LF-normalized text identity / exact-byte binary identity (the Windows CRLF finding
  stands: exact-byte matching would misclassify every Windows install as modified).
- Bounded inventory work limits, topology classification (symlink dedup, external links,
  plugin caches and repo scopes excluded), and the launch / focus / post-install triggers.
- The skills-CLI round-trip CI on macOS/Linux/Windows — extended from current-install tests
  to historical-fat-install → targeted global update → stub migration. The matrix covers
  copy/symlink shapes, LF/CRLF, supported lock migrations, and post-update identity.

Slimmed:
- Statuses collapse to: `current`, `outdated` (exact match of an older released snapshot),
  `newer-known`, `unrecognized`, and `inaccessible`. Without a ledger, Orca cannot honestly
  distinguish a locally modified official copy from unrelated same-named content;
  `unrecognized` says it may be edited or from another source. All `managed-*` states, the
  ledger, adoption eligibility, and attribution are removed.
- Status and action eligibility are separate. External links, read-only locations, plugin
  caches, repo scopes, and unsupported topologies remain informational even when their bytes
  match an official snapshot.
- Dismissal state for the nudge is a simple local dismissed-set keyed by
  (physical identity, skill, bundled revision) in app state — not a consent ledger.

### D. Surfacing

- **Settings rows** (read-only): name, status badge, one-line explanation. `newer-known`,
  `unrecognized`, `inaccessible`, and unsupported-topology rows are informational.
- **Name-scoped update eligibility:** the skills CLI reinstalls every placement of a selected
  skill name, so eligibility is computed across all discovered placements of that name, not
  per row. Offer a name only when at least one placement is `outdated` and every placement is
  an exact `current` or `outdated` official snapshot in a supported global topology. One
  `newer-known`, unrecognized, external, read-only, inaccessible, or otherwise unsupported
  provider copy poisons the update offer for that name entirely.
- The action combines only eligible outdated Orca names into
  `npx skills update <names...> --global`, opens the existing run-command terminal with that
  command pre-filled, and leaves execution to the user. Never use an unscoped bulk update and
  never auto-submit the command. Re-inventory after terminal exit or focus; only observed
  bytes, not the skills CLI exit status, determine success.
- **One non-repeating nudge**: count only eligible outdated skill names and offer the same
  targeted run-the-command action. An outdated name poisoned by another placement remains
  visible in settings but never produces an unsafe nudge action. Dismissal is recorded per
  (install, bundled revision), so a newly outdated official placement or genuinely newer
  stub revision may prompt once more. No toggle — nothing automatic happens that would need
  one.

### E. Migration (fat → stub)

1. **Implemented, pending release:** from a fresh main-based PR, add authoritative guide
   sources, generated embedded data, `orca skills list/get`, aliases, generated-output checks,
   and local/SSH/WSL/dev tests. Keep distributed skills fat and ship this release first.
2. From a separate PR, land slim read-only detection and settings/nudge UI, including the
   name-scoped targeted update action and the real migration-rail CI. Keep distributed
   skills fat.
3. Run the pointer-compliance spike against the released guide-serving binary, not a checkout
   artifact. The binary must be publicly released before a stub PR merges because the skills
   CLI installs from repository main, independently of Orca's desktop release train.
4. In one PR, convert only `orca-cli` to a first-generation hybrid stub and keep any final
   thinning of that stub in the same change. This bumps its registry revision like any content
   change. Existing users see an `outdated` exact snapshot and may run the targeted global
   update; users of pre-guide binaries retain the hybrid bootstrap.
5. Cut an RC before the stable release and use that validation window to measure compliance,
   task success, old-binary behavior, and token cost. Ship the thin form in stable only if those
   gates pass; otherwise retain the hybrid. Convert the remaining skills gradually in later PRs.
   Users who ignore the nudge keep working with their existing fat skills.

## Spike gate (before any stub ships)

Using the released guide-serving binary, install the proposed hybrid `orca-cli` stub in a
test home and run real agents (Claude Code, Codex) on representative Orca tasks. Measure:

- how often the agent resolves the correct packaged/Linux/WSL/SSH/dev command and fetches the
  guide before its first Orca command;
- task success versus the fat skill;
- old-binary failure behavior; and
- net token cost (stub preload + one fetch versus fat preload).

Then test a thinner stub against the same corpus. Nothing converts, and the hybrid stub does
not thin, until the relevant variant passes.

## Risks and open questions

- **npx rail reliability.** The skills CLI update path has had false "up to date" results,
  global Windows failures, missing global lock tracking, lossy lock migration, and copy-mode
  topology changes. The historical-fat → targeted-global-update → stub CI is a release gate,
  not an early-warning job. Detection always re-checks bytes after the user updates, so a
  failed or no-op update re-surfaces `outdated` instead of lying. Choose and document a
  validated CLI-version policy before rollout; monitor and contribute upstream fixes.
- **Trigger-copy iteration slows.** Improvements to stub descriptions reach existing
  installs only when users run the npx command. Acceptable at stub-change cadence; the
  compiled guides (the content that matters) are exempt by construction.
- **Multi-file skills.** Current shipped packages are single-file. If a future skill needs
  scripts/assets, either the binary serves them (`--full` / `--script`) or that skill
  accepts the fat-file decay model. Decide when it happens.
- **Remote hosts.** Detection ships local-host-only. Stubs make remote *content* a non-issue:
  SSH/WSL launchers forward to the host's bundled CLI, so the guide matches the command
  surface that will handle subsequent requests. Remote stub installs can lag on trigger
  copy, which is the accepted residual. The WSL/SSH reconciler phases of the old design are
  retired, not deferred.
- **Agent Skills spec evolution** (frontmatter fields, allowed-tools syntax) is the most
  likely future cause of a real stub update wave; the nudge path covers it.

## Relationship to prior notes

- `skill-auto-update-design.md`: Problem statement, empirical CLI-behavior findings
  (verbatim-LF mac/linux, CRLF Windows, XDG lock location, symlink topology, released-blob
  provenance) and the Phase-1 detection design remain valid inputs. Phases 2–4 (background
  writes, WSL, SSH reconcilers) are retired by this document.
- `skill-guide-indirection-design.md`: The stub/CLI contract and prior-art survey are
  folded in here; its migration-via-in-app-updater section is superseded by §E.
