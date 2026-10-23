# Contributing to Orca

Thanks for contributing to Orca.

## Before You Start

- Keep changes scoped to a clear user-facing improvement, bug fix, or refactor.
- Orca targets macOS, Linux, and Windows. Every change must stay compatible with all three platforms unless the code is explicitly guarded by a runtime platform check.
- For keyboard shortcuts, use runtime platform checks in renderer code and `CmdOrCtrl` in Electron menu accelerators.
- For shortcut labels, show `⌘` and `⇧` on macOS, and `Ctrl+` and `Shift+` on Linux and Windows.
- For file paths, use Node or Electron path utilities such as `path.join`.
- Orca must work against local repositories, remote servers, and SSH worktrees. Do not assume a process, file, credential, shell, or network path exists only on the local machine.
- Orca supports many CLI agents, integrations, and git providers. Keep generic behavior provider-neutral; guard integration-specific logic behind explicit checks.
- Keep changes well-engineered and performant: follow existing architecture, avoid unnecessary work in hot paths, clean up owned resources, and use concrete module names.
- For UI work, follow [`docs/STYLEGUIDE.md`](../docs/STYLEGUIDE.md), use the tokens and shadcn primitives it specifies, and verify polished behavior across platforms, light/dark mode, and SSH latency.

## Local Setup

Install Node 24, pnpm, and the Bun version in [`config/.bun-version`](../config/.bun-version).
`pnpm test` runs Vitest on Bun, with Node workers for runtime contracts such as SQLite,
native PTYs, socket liveness, and V8 memory behavior. `pnpm test:node` runs the same suites
entirely on Node. Builds and dependency installation still use Node and pnpm.

```bash
pnpm install
pnpm dev
```

To reduce main-process rebuild CPU and memory when you do not need its source maps,
set `ORCA_DEV_MAIN_SOURCEMAPS=0` before `pnpm dev`. In Bash/zsh:

```bash
ORCA_DEV_MAIN_SOURCEMAPS=0 pnpm dev
```

In PowerShell, use `$env:ORCA_DEV_MAIN_SOURCEMAPS='0'` before `pnpm dev`.
Remove the variable when debugging the main process with source maps. Renderer and
preload settings are unaffected; production builds always keep their hidden main maps.

Local installs use pnpm's global virtual store: each package version is one slot
under `~/pnpm/store` that every worktree links to, instead of a full `node_modules` per worktree.
An existing worktree converts on its next `pnpm install`, and an older branch without the setting
converts back the same way. CI always uses the normal layout. On Windows, pnpm links with
junctions when you lack the symlink privilege, so no administrator rights or Developer Mode are
needed. Things to know:

- Keep `~/node_modules` (and any other `node_modules` above the store) out of your home
  directory. Node resolves upward from the store slot, so a stray one there supplies
  dependencies the package never declared and hides missing-dependency bugs; `pnpm install` warns
  when it finds one.
- Native addons are never rebuilt in place in a shared slot: each CPU gets its own build
  beside it (see [`native-build-entry.cjs`](../config/scripts/native-build-entry.cjs)), so
  cross-arch packaging is safe for other worktrees.
- `ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0` opts out. Keep it set
  in your shell: `pnpm run` re-checks the install and relinks a worktree whose layout no longer
  matches.

Ordinary installs include native optional dependencies for the current OS and CPU only.
Before a cross-architecture build (including `pnpm build:mac`, which produces both x64 and
arm64 artifacts by default), run `pnpm install:release` to add the other CPU's variants.

Linux `pnpm build`, `pnpm build:native`, and Linux packaging require a running Docker
daemon to build the clipboard helper against Ubuntu 20.04 rather than the host's
newer libraries. A verified cached helper can be reused without Docker. For native
Wayland development, run `pnpm build:native` before `pnpm dev` to make text copying
available. See the [clipboard build guide](../native/wayland-clipboard/README.md#building-and-testing).
macOS and Windows builds do not use this helper or require Docker for it.

## Branch Naming

Use a clear, descriptive branch name that reflects the change.

Good examples:

- `fix/ctrl-backspace-delete-word`
- `feat/shift-enter-newline`
- `chore/update-contributor-guide`

Avoid vague names like `test`, `misc`, or `changes`.

## Before Opening a PR

Run the same checks that CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For repeated local typechecks, use `pnpm tc` (or `pnpm tc:node`, `pnpm tc:web`,
and `pnpm tc:cli`). On Apple Silicon macOS and x64/arm64 Linux, these use the pinned
`tsrs` compiler with incremental caches. Keep `.cache/typecheck/` between checks;
delete it to force a fresh check. Caches are separate for each project, compiler
version, and worktree. At most two projects run together, subject to the memory budget.
Windows, Intel macOS, and other unsupported platforms use pinned Bun automatically.
Pass `--compiler=bun` to explicitly use Bun, or `--compiler=native` to use TypeScript.
CI uses `pnpm typecheck:ci`, which explicitly selects Bun and its CI concurrency.
Shared tests are checked by the
Node project; shared production code is checked in all three environments.
Run `pnpm tc:node` after editing shared tests, or `pnpm tc` to check everything.

Add high-quality tests for behavior changes and bug fixes. Prefer tests that would actually catch a regression, not shallow coverage that only exercises the happy path.

If your change affects UI or interaction behavior, verify it on the platforms it could impact.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's `skipLibCheck: true` setting applies globally, including to our own `.d.ts` files, which means any unresolved type reference in a `.d.ts` silently becomes `any` at its call sites. Write your types in `.ts` files so the compiler actually checks them.

CI enforces this for `src/preload/` and `src/shared/`.

## Pull Requests

Each pull request should follow [`.github/pull_request_template.md`](./pull_request_template.md). In particular:

- if you are an outside contributor, link the issue your PR addresses
- open with an ELI5 of the change (plain language paragraph; the PR title is the one-liner)
- explain what changed and why, and stay focused on a single topic when possible
- for any UI or interaction change, attach **before and after** screenshots (or short videos); if there is no visual or interaction change, write `N/A` and briefly explain why
- include high-quality tests when behavior changes or bug fixes warrant them
- include a brief code review summary from your AI coding agent that explicitly checks cross-platform compatibility, SSH/remote/local compatibility, supported agent and integration compatibility, performance risk, UI quality when applicable, and basic security risk
- mention any platform-specific, remote/SSH-specific, agent-specific, integration-specific, or git-provider-specific behavior and testing notes
- **Include your X (Twitter) handle** in the PR template Author section — we shout out contributors when we merge features on [@orca_build](https://x.com/orca_build).

## Release Process

Version bumps, tags, and releases are maintainer-managed. Do not include release version changes in a normal contribution unless a maintainer asks for them.

### Cutting a release (maintainers)

All releases are cut from the **Cut Release** GitHub Actions workflow. There is no local `pnpm release:*` script — running releases locally is too easy to get wrong (dirty tree, wrong branch, stale main).

**To cut a release:**

1. Open [Actions → Cut Release](../../actions/workflows/release-cut.yml).
2. Click **Run workflow** and pick:
   - **kind**: one of `rc`, `patch`, `minor`, `major`.
   - **ref**: the branch, tag, or SHA to build from. Defaults to `main`.
3. Run it.

The workflow resolves the next version from GitHub Releases, bumps `package.json`, tags, pushes, and runs the multi-platform build + publish inline.

**How the next version is chosen:**

All stable kinds (`patch`, `minor`, `major`) are computed off the latest _stable_ release, ignoring any RCs in between.

- `kind=rc` + last tag was stable (e.g. `v1.3.14`) → `v1.3.15-rc.0`.
- `kind=rc` + active RC series (e.g. `v1.3.15-rc.2`) → `v1.3.15-rc.3`.
- `kind=patch` + latest stable `v1.3.14` → `v1.3.15` (regardless of any intermediate RCs).
- `kind=minor` + latest stable `v1.3.14` → `v1.4.0`.
- `kind=major` + latest stable `v1.3.14` → `v2.0.0`.

**Safety guarantees:**

- Stable releases are refused if the new version isn't strictly greater than the latest published stable. This is the only rule `electron-updater` actually needs — it compares semver within the `latest` channel, so a regressing stable is the one thing that breaks auto-update for fresh installs.
- Complete RC draft releases created by the release workflow are published before cutting a new tag only when the draft tag was built from the current release ref. Stale drafts are skipped so fixes cut a fresh RC instead of exposing old artifacts.
- If the latest RC tag exists but is still draft-only or missing its GitHub Release, the workflow resumes that tag only when it was built from the current release ref. Otherwise the next RC number is cut.
- RC numbering also considers release commits on `main`, so deleting a stale tag does not let a later cut reuse the same RC number.
- Off-main releases (when `ref` is not the tip of `main`) only push the tag. `main` is never mutated from a non-main ref, so you can safely release an older commit without polluting history.
- When `ref` is the tip of `main`, the workflow tries to fast-forward the version-bump commit onto `main`. If main requires pull requests, it leaves main unchanged and pushes only the release tag. Other push errors still stop the cut.

**Common scenarios:**

- **Normal release:** `kind=patch`, `ref=main`.
- **"A bad commit just landed on main, release the commit before it":** `kind=patch`, `ref=<good-sha>`. `main` is left alone; the tag points at the good SHA. Fix forward on `main` afterward.
- **One-off RC for a feature branch:** `kind=rc`, `ref=<branch-or-sha>`. Produces an RC tag that does not touch `main`.
- **Minor or major bump:** `kind=minor` or `kind=major`.

The scheduled 2x/day RC cron in [`release-rc.yml`](../../actions/workflows/release-rc.yml) is independent and continues to run automatically from `main`.

## Release Channels

The public Homebrew cask tracks stable desktop releases:

```bash
brew install --cask stablyai/orca/orca
```

Release candidates use a separate cask token:

```bash
brew install --cask stablyai/orca/orca@rc
```

The two casks conflict because both install `Orca.app`. Switch channels with a
normal `brew uninstall --cask` followed by the install for the other channel.
Do not use `--zap` unless you intentionally want to remove local Orca state.
