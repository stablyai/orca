# Useful Commands

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: `pnpm test [path/to/file.test.ts] --maxWorkers=2`; incremental: `pnpm test:changed [path] --maxWorkers=2` ([details](.github/CONTRIBUTING.md#targeting-local-tests)). Separate rendered UI E2E checks need explicit, reproducible viewport/state.
- **Lint/format**: Basic: `pnpm exec oxlint <files>`; full lint gate: `pnpm lint`; formatting: `pnpm exec oxfmt --check <files>` (fix: `--write`). Applicable gates include `pnpm check:code-quality:changed <base>` and `pnpm check:flaky-test-pattern-ratchet`.

Optional: `pnpm check:changed --maxWorkers=2`; if selection fans out excessively, use scoped checks and report limits. Use the PR base (default `origin/main`; `ORCA_CODE_QUALITY_BASE=<ref>` for stacks). `--base=HEAD` and dirty-only checks provide incremental evidence only.

> [!IMPORTANT]
> Always lint changed files before making/pushing-to PRs (so CI never fails on it)

# Don't Poll the CI

Use `gh run watch <run-id> --compact --exit-status` or `gh pr checks --watch` to prevent token waste

# Repo Rules

- Ensure main is always releasable
- Never break the CI. If it's broken borken, merge fixes.
- Avoid low-value tests (see [Anti-patterns](./docs/agents-md-refs/test-antipatterns.md))

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role.

# Electron UI Validation

- Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
- Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`, `app.focus()`, or OS activation. Use CDP screenshots of hidden renderers.
- Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
- Rebuild modified launch-policy code before running an app (stale build wrappers are not safe).
- Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.
- Screenshot presentational components without Electron: `pnpm fixtures:shot <id>` ([fixtures](docs/agents-md-refs/component-fixtures.md)).

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale extend or generalize it instead of building a parallel version.

## Avoid Comments

- Only use when code does not describe
- BE CONCISE. 1 LINE if possible (why not how)

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

# First Class Citizens

Every change must consider these areas:

1. Cross-Platform Support (mac/linux/windows) * Guard platform-specific behavior at runtime; use platform-aware shortcuts, paths, and existing process wrappers. Before changing platform-specific code, processes, shells, shortcuts, paths, or native modules, read [`docs/agents-md-refs/cross-platform-support.md`](./docs/agents-md-refs/cross-platform-support.md).
2. Remote hosts * Features should work locally and on remote hosts
3. Mobile
4. Folder Workspaces * Don't assume every workspace is a git worktree.

# Footguns

## Git / GitHub

If changing code around `git`, `gh`, source-control, or review behavior read [`docs/agents-md-refs/git-workflow.md`](./docs/agents-md-refs/git-workflow.md).
