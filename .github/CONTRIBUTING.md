# Contributing to Orca

Thanks for contributing to Orca.

Found a security vulnerability? Do not open a public issue or PR; report it privately as described in [`SECURITY.md`](./SECURITY.md).

## Local Setup

Install Node 24, the pnpm version in `packageManager` in [`package.json`](../package.json), and the Bun version in [`config/.bun-version`](../config/.bun-version). `pnpm install` compiles native modules, so you also need a C++ toolchain and Python 3 (Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows, `build-essential` and Electron's libraries on Linux).

```bash
pnpm install
pnpm -C mobile install --frozen-lockfile   # mobile/ has its own lockfile; build and lint need it
pnpm dev
```

`pnpm dev` in a linked Git worktree uses its own profile and ports, so instances in different worktrees run side by side.

See [`docs/development.md`](../docs/development.md) for per-OS packages, Corepack and Windows notes, dev profiles and seeding, cross-architecture and Linux (Docker) builds, and troubleshooting.

## Branch Naming

Use a clear, descriptive branch name that reflects the change, such as `fix/ctrl-backspace-delete-word`, `feat/shift-enter-newline`, or `chore/update-contributor-guide`. Avoid vague names like `test`, `misc`, or `changes`.

## Code Guidelines

- Keep changes scoped to a clear user-facing improvement, bug fix, or refactor.
- Orca targets macOS, Linux, and Windows. Guard platform-specific code with runtime checks, use `CmdOrCtrl` in Electron menu accelerators, show `⌘`/`⇧` labels on macOS and `Ctrl+`/`Shift+` elsewhere, and build paths with `path.join`. See [cross-platform support](../docs/agents-md-refs/cross-platform-support.md).
- Orca must work against local repositories, remote servers, and SSH worktrees. Do not assume a process, file, credential, shell, or network path exists only on the local machine.
- Keep generic behavior provider-neutral across CLI agents, integrations, and git providers; guard integration-specific logic behind explicit checks.
- Follow existing architecture, avoid unnecessary work in hot paths, clean up owned resources, and use concrete module names.
- For UI work, follow [`docs/STYLEGUIDE.md`](../docs/STYLEGUIDE.md) and verify behavior across platforms, light/dark mode, and SSH latency.

### Type Declarations: Prefer `.ts` Over `.d.ts`

Put project-owned types in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`). `skipLibCheck: true` applies to our own `.d.ts` files too, so an unresolved type reference there silently becomes `any`. CI enforces this for `src/preload/` and `src/shared/`.

## Checks Before Opening a PR

Run the same checks CI runs, after the `mobile/` install above:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For faster repeat typechecks use `pnpm tc` (or `pnpm tc:node`, `pnpm tc:web`, `pnpm tc:cli`); run `pnpm tc:node` after editing shared tests.

Add a test when it would catch a regression of your behavior change or bug fix, not for shallow coverage; see [test anti-patterns](../docs/agents-md-refs/test-antipatterns.md). If your change affects UI or interaction behavior, verify it on the platforms it could impact.

### Targeting Local Tests

Use `pnpm test`, not raw `vitest`: only it keeps the transform cache that makes repeat runs fast.

```bash
pnpm test src/shared/automations/scheduling/automation-cron-input-validation.test.ts --maxWorkers=2
pnpm test:changed src/main/runtime --maxWorkers=2   # staged, unstaged, and untracked changes
pnpm test --changed=origin/main --maxWorkers=2      # also commits since the merge base
```

Affected tests follow Vitest's static import graph, so run suites explicitly for dynamic imports, fixtures, or subprocess inputs. Local affected tests do not replace CI. If a file passes alone but fails after others, add `// @orca-isolated-worker` to it.

## Pull Requests

Fill in every section of [`.github/pull_request_template.md`](./pull_request_template.md): an ELI5, what changed and why, a linked issue (required for outside contributors), a before and after (screenshots or videos) for any UI or behavior change (only if there is truly no visual or interaction change, write exactly `N/A` and briefly say why), how you tested it, the risk, and under Review a short summary from your AI coding agent covering cross-platform, SSH/remote, agent and integration compatibility, performance, UI quality, and security. Keep each PR small and focused on one topic.

Version bumps, tags, and releases are maintainer-managed. Do not include release version changes unless a maintainer asks. Maintainers cut releases with the [Cut Release](https://github.com/stablyai/orca/actions/workflows/release-cut.yml) workflow.

## Getting Help

Ask questions on [Discord](https://discord.gg/fzjDKHxv8Q), or open an [issue](https://github.com/stablyai/orca/issues/new/choose) for bugs and feature requests.
