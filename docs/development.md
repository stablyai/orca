# Orca Development Environment

Setup details beyond [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md).

## Prerequisites

Install Node 24, the pnpm version in `packageManager` in [`package.json`](../package.json), and the Bun version in [`config/.bun-version`](../config/.bun-version).

The server, its workers, and its packaged dependencies target Node 24. The compatibility launcher and CLI still target Node 18; the launcher hands off to bundled Node 24 before loading server code. WSL guest programs and host discovery retain their Node 18 minimum. Keep Node 24 APIs and server imports out of these host compatibility paths. Running an unpackaged server directly requires Node 24 or newer.

`corepack enable` needs Corepack 0.34.5 or newer (`npm install -g corepack@latest`). On Windows it fails with `EPERM` outside an elevated shell when Node is in `C:\Program Files\nodejs`; run `npm install -g pnpm@<that version>` instead.

`pnpm install` compiles native modules such as `node-pty`, so a fresh machine also needs:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Windows**: Python 3 and Visual Studio Build Tools with the "Desktop development with C++" workload.
- **Linux**: a C++ toolchain, Python 3, Electron's libraries, and `xvfb` (used by `*.electron.test.ts` when `DISPLAY` is unset). On Ubuntu 24.04+ and Debian 13+ (older releases name the last package `libasound2`):

  ```bash
  sudo apt-get update && sudo apt-get install -y build-essential python3 xvfb libgtk-3-0 libnss3 libgbm1 libasound2t64
  ```

Re-run `pnpm -C mobile install --frozen-lockfile` whenever `mobile/pnpm-lock.yaml` changes.

## Dev Profiles and Parallel Instances

`pnpm dev` in a linked Git worktree uses its own profile, renderer port (from 15200), and CDP port (from 9333), so worktrees run side by side. The main checkout uses the shared `orca-dev` profile. The chosen profile and ports are printed on an `ORCA_DEV_INSTANCE` line and written to `out/dev-instance.json`.

| Option                                                                  | Effect                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev --shared-profile` or `ORCA_DEV_PROFILE=shared`                | Use the shared `orca-dev` profile                          |
| `pnpm dev --worktree-profile` or `ORCA_DEV_PROFILE=worktree`            | Use a per-worktree profile, including in the main checkout |
| `ORCA_DEV_USER_DATA_PATH=<dir>`                                         | Use an explicit profile directory                          |
| `REMOTE_DEBUGGING_PORT=<port>`, `ORCA_DEV_RENDERER_PORT=<port>`         | Pin a port                                                 |
| `pnpm dev --seed-profile[=<dir>]` or `ORCA_DEV_SEED_PROFILE=<dir or 1>` | Seed an empty profile on first launch                      |

After a worktree is removed and no process still uses its profile, a later `pnpm dev` can automatically delete that profile and its saved state. Back up any state you need before removing the worktree; the `userData` field in `ORCA_DEV_INSTANCE` or `out/dev-instance.json` gives the profile directory.

Seeding copies projects, workspaces, settings, SSH targets, and the Orca account session from another profile (default `orca-dev`, else the installed app's). Seed from `orca-dev` if you need to stay signed in: dev builds cannot decrypt secrets the installed app encrypted.

```bash
pnpm dev:seed-profile [--from=<profile dir>] [--to=<profile dir>] [--reset]
pnpm dev:fresh [--keep] [--seed-from[=<profile dir>]]   # temporary profile, removed on exit
```

## Installs and Builds

- Local installs use pnpm's global virtual store (`~/pnpm/store`) shared by all worktrees. Do not keep a `node_modules` in your home directory: it hides missing-dependency bugs. Set `ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0` in your shell to opt out.
- Before a cross-architecture build (including `pnpm build:mac`, which builds x64 and arm64), run `pnpm install:release`.
- On Linux, `pnpm build`, `pnpm build:native`, and packaging need a running Docker daemon for the clipboard helper. For native Wayland development, run `pnpm build:native` before `pnpm dev`. See the [clipboard build guide](../native/wayland-clipboard/README.md#building-and-testing).

## Troubleshooting

- Slow main-process rebuilds: set `ORCA_DEV_MAIN_SOURCEMAPS=0` before `pnpm dev` when you don't need main-process source maps.
- Renderer misbehaving in dev: set `ORCA_DEV_BUNDLED=0` to turn off bundled dev mode, and report it.
- Test passes alone but fails after others: add `// @orca-isolated-worker` to the file; `ORCA_VITEST_ISOLATE_EVERY_FILE=1` isolates every file to confirm a leak. Windows always isolates every file, because native addons kept across files corrupt the heap.
- Slow typechecks: where supported, `pnpm tc` keeps incremental caches in `.cache/typecheck/`; delete it to force a fresh check.
