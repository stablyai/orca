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
| `worktree-list-z`       | NUL-delimited worktree paths                      | Line-block parser for Git before `worktree list -z`                                     |
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
