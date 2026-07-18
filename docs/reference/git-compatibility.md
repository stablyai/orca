# Git Compatibility Policy

## Scope

Orca executes the user's Git binary on three kinds of execution host: native,
WSL, and SSH. Each host can have a different Git version, so compatibility
state must be scoped to the host that actually runs the command.

Git 2.25 is the core-workflow compatibility baseline for command selection. It
is the oldest line that covers Orca's baseline use of porcelain v2, `branch
--show-current`, `restore`, and sparse checkout. Optional features that need a
newer Git must degrade safely and cache the missing capability. Orca does not
currently block older Git at startup, but new command construction should not
assume features introduced after this baseline.

## Capability Rules

When a newer Git feature materially improves correctness or performance:

1. Keep a baseline-compatible command or parser as the fallback.
2. Detect rejection with a narrow predicate for that option or subcommand.
3. Run the preferred command through `GitCapabilityCache` so a rejection is
   remembered for the native host, WSL distro, or SSH provider that produced it.
4. Retry after the cache interval so an in-place Git upgrade self-heals without
   restarting Orca.
5. Test the first fallback, later calls that skip the rejected probe, concurrent
   probe coalescing, and execution-host isolation where applicable.

Do not branch only on a parsed `git --version`. Vendor builds can backport
features, and wrappers can report a host version that differs from the binary
used inside WSL or SSH. A behavior probe plus a precise fallback is the final
authority.

## Current Capabilities

| Capability              | Preferred behavior                                | Compatibility behavior                                                                  |
| ----------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `worktree-list-z`       | NUL-delimited worktree paths with `prunable` marks | Line-block parser for Git before `worktree list -z` (2.36); the `prunable`/`locked` annotations still parse on Git 2.31–2.35, and a path-existence probe restores `prunable` detection for Git before 2.31 |
| `rev-parse-path-format` | Absolute repo metadata paths                      | Resolve legacy relative output against the scanned repo                                 |
| `for-each-ref-exclude`  | Exclude remote HEAD before the output limit       | Request extra refs, then filter remote HEAD in Orca                                     |
| `merge-tree-write-tree` | Derive real-merge conflicts and no-op tree proofs | Omit the conflict summary and keep conservative branch cleanup behavior before Git 2.38 |
| `merge-tree-merge-base` | Supply the already-resolved merge base            | Use the older two-commit `merge-tree --write-tree` form                                 |

## Why Not `simple-git`

`simple-git` is a process wrapper around the installed Git binary. Its custom
options and `raw` API pass arguments through to Git, so it cannot make a newer
flag work on an older binary or choose Orca's semantic fallback automatically.
It provides version reporting and subprocess queueing, but Orca already needs
its own WSL/SSH routing, cancellation, tracing, redaction, process cleanup, and
bounded output handling. Replacing the runner would move—not remove—the
capability problem.

## CI Contract

PR checks run the capability contract against real Git 2.25.5, 2.38.1, and
2.49.1 binaries. This spans the core-workflow baseline, the transitional
`merge-tree --write-tree` behavior before `--merge-base`, and current Git.

Keep the unit tests alongside that matrix. They cover concurrent probes,
native/WSL/SSH/relay isolation, and error-stream shapes that a single real
binary invocation cannot exercise deterministically.

## Native blob reads (experimental)

The `experimentalNativeGit` setting routes diff blob reads (`git show <rev>:<path>`
and `git show :<path>`) through an in-process gitoxide reader (`native/git-native`)
instead of `git` subprocess spawns. It is **off by default**; there is no settings-UI
toggle yet (enable via the setting in the config file or the `ORCA_NATIVE_GIT` env).
Compatibility contract:

- The reader bypasses the user's git binary entirely, so it adds **no** git-version
  surface. The CLI path remains intact and is the automatic fallback whenever the
  native addon is missing, fails to load, errors on a read, or a sampled verification
  detects any divergence from CLI output — in which case the session "poisons" back
  to CLI-only for its lifetime and emits a `git_native_shadow_divergence` telemetry
  event (`read_kind` + `divergence` only; no paths or content).
- Scope: native-host repos only. WSL-routed repos (`\\wsl.localhost` UNC paths or a
  `wslDistro` option) and SSH worktrees always use the existing CLI / relay paths.
- Modes (env `ORCA_NATIVE_GIT` overrides the setting): `0` / `off` / `false` force
  CLI; `1` forces native; `shadow` dual-runs every read, serves the CLI result, and
  reports any divergence. With no env override, the `experimentalNativeGit` setting
  decides on/off.
- Verification: a differential parity suite (`blob-reader.parity.test.ts`) compares
  native output against real `git` byte-for-byte over a fixture matrix (loose and
  packed objects, CRLF, unicode paths, binary, empty files, the 10 MB size boundary,
  staged vs HEAD, linked-worktree private index, unmerged paths). CI builds the addon
  and runs this suite under `ORCA_REQUIRE_GIT_NATIVE=1` so a missing addon fails loudly.
  Coverage boundary: PR CI gates parity on Linux only; macOS/Windows byte parity relies
  on `shadow` telemetry rather than a per-platform CI gate (gix is platform-agnostic and
  paths are forward-slash-normalized before the read), so flip the flag on for real users
  only after clean cross-platform `shadow` results.
- Known intentional divergences (native returns not-found; excluded from the parity
  oracle): gitlink/submodule entries and sparse-dir entries — `git show` pretty-prints
  a locally-resolvable gitlink commit, but Orca routes submodules away before blob
  reads so this path is never hit in production. Also on the shadow-telemetry watchlist:
  `git replace` refs and sparse-index repositories.
