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

The server, its workers and its packaged dependencies target Node 24. The compatibility
launcher and CLI still target Node 18; the launcher hands off to bundled Node 24 before
loading server code. WSL guest programs and host discovery retain their Node 18 minimum.
Keep Node 24 APIs and server imports out of these host compatibility paths. Running an
unpackaged server directly requires Node 24 or newer.

Use the pnpm version in `packageManager` in [`package.json`](../package.json): `corepack enable`
needs Corepack 0.34.5 or newer to start the pinned pnpm (`npm install -g corepack@latest`). On
Windows it writes shims next to `node.exe` and fails with `EPERM` outside an elevated shell when
Node is in `C:\Program Files\nodejs`; run `npm install -g pnpm@<that version>` instead.

`pnpm install` compiles native modules such as `node-pty` with `node-gyp` and loads them in
Electron, so a fresh machine also needs:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Windows**: Python 3 and Visual Studio Build Tools with the "Desktop development with C++"
  workload.
- **Linux**: a C++ toolchain, Python 3, and the libraries Electron loads even on a headless
  machine, plus `xvfb`, which the `*.electron.test.ts` files in `pnpm test` use when `DISPLAY` is
  unset. On Ubuntu 24.04+ and Debian 13+:

  ```bash
  sudo apt-get update && sudo apt-get install -y build-essential python3 xvfb libgtk-3-0 libnss3 libgbm1 libasound2t64
  ```

  Older releases name the last package `libasound2`.

```bash
pnpm install
pnpm dev
```

### Dev Profiles and Parallel Instances

`pnpm dev` in a linked Git worktree uses its own userData profile, renderer port, and remote
debugging (CDP) port, so dev instances in different worktrees run side by side. The main checkout
keeps the shared `orca-dev` profile. Ports are derived from the worktree path and move to the next
free port when taken: renderer ports start at 15200 and CDP ports at 9333.

On startup the runner prints one stdout line and writes the same JSON to `out/dev-instance.json`:

```text
ORCA_DEV_INSTANCE {"userData":".../orca-dev-wt/1d3830d4d3","profile":"worktree","rendererPort":15339,"rendererUrl":"http://localhost:15339","cdpPort":9513,"cdpUrl":"http://127.0.0.1:9513","repoRoot":"...","runnerPid":4242}
```

| Option                                                                  | Effect                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev --shared-profile` or `ORCA_DEV_PROFILE=shared`                | Use the shared `orca-dev` profile                          |
| `pnpm dev --worktree-profile` or `ORCA_DEV_PROFILE=worktree`            | Use a per-worktree profile, including in the main checkout |
| `ORCA_DEV_USER_DATA_PATH=<dir>`                                         | Use an explicit profile directory                          |
| `REMOTE_DEBUGGING_PORT=<port>`, `ORCA_DEV_RENDERER_PORT=<port>`         | Pin a port                                                 |
| `pnpm dev --seed-profile[=<dir>]` or `ORCA_DEV_SEED_PROFILE=<dir or 1>` | Seed an empty profile on first launch                      |

Per-worktree profiles live in `orca-dev-wt/<hash>` next to `orca-dev` (`~/Library/Application
Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux). The
automatic storage cleanup removes them once their worktree is gone and nothing still runs from
them. `config/scripts/orca-dev.mjs` and the `orca-dev` terminal wrapper target the profile this
checkout's `pnpm dev` used.

Seeding copies a slim set of state from another profile: projects, workspaces, settings, SSH
targets, and the Orca account session. Terminal sessions, PTY leases, automations, caches, logs,
and lock files are not copied, and the source profile is only read. The default source is
`orca-dev`, or the installed app's profile when `orca-dev` is empty. Seed from `orca-dev` when you
need the signed-in account session: dev builds cannot decrypt secrets the installed app encrypted.

```bash
pnpm dev:seed-profile [--from=<profile dir>] [--to=<profile dir>] [--reset]
pnpm dev:fresh [--keep] [--seed-from[=<profile dir>]]   # temporary profile, removed on exit
```

### Targeting Local Tests

Use a test file or directory when you know the relevant suites. For dependency-based
feedback, Vitest can select tests affected by your edits:

```bash
pnpm test:changed src/main/runtime --maxWorkers=2
pnpm test --changed=origin/main --maxWorkers=2
pnpm test src/shared/app-version.test.ts --maxWorkers=2
```

`test:changed` considers staged, unstaged, and untracked files. `--changed=origin/main`
also includes committed changes since the branch's merge base. Update that ref when
you need a newer baseline. Both accept the same path filters and options as `pnpm test`.
When Git reports no changed files at all, the launcher exits before starting Vitest.

Affected tests use Vitest's static import graph. Run suites explicitly for computed
dynamic imports, fixture files, subprocess inputs, or other dependencies outside that
graph. Local affected tests do not replace CI.

To reduce main-process rebuild CPU and memory when you do not need its source maps,
set `ORCA_DEV_MAIN_SOURCEMAPS=0` before `pnpm dev`. In Bash/zsh:

```bash
ORCA_DEV_MAIN_SOURCEMAPS=0 pnpm dev
```

In PowerShell, use `$env:ORCA_DEV_MAIN_SOURCEMAPS='0'` before `pnpm dev`.
Remove the variable when debugging the main process with source maps. Renderer and
preload settings are unaffected; production builds always keep their hidden main maps.

`pnpm dev` serves the renderer with Vite's bundled dev mode: a few bundled chunks instead of
thousands of module requests, so the first render and full reloads are faster. While a rebuild is
pending, a newly opened pop-out, space, or web window may briefly get placeholder HTML. If the
renderer misbehaves, set `ORCA_DEV_BUNDLED=0` (PowerShell: `$env:ORCA_DEV_BUNDLED='0'`) and report it.

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

`pnpm lint` runs independent checks in a bounded pool. Use
`pnpm lint --maxWorkers=2 --timings` to limit concurrent checks and print their durations.

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
