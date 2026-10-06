# Verifying the W1–W3 Windows/WSL work

Unit and real-binary tests cover Windows and WSL behavior.

## 1. Unit — runs everywhere, every PR

| Suite                                             | Pins                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/wsl/wsl-runner.test.ts`                 | Separator, lane selection, fencing, WSLENV, guest cwd, script interpreter, budget split, refusal on unresolved PATH                                           |
| `src/main/wsl/wsl-guest-environment.test.ts`      | Burst collapse, per-distro isolation, malformed-payload rejection, transient vs permanent, retry windows, joiner budget                                       |
| `src/main/wsl/wsl-w1-w3-contract.test.ts`         | The W1→W3 chain end to end: absolute `wsl.exe`, argv array, bounded call, no `--`, script byte-identical, WSLENV, no shell on probe, login PATH still applied |
| `src/shared/source-scan/source-tree-scan.test.ts` | The guard helpers. A guard that under-reports is worse than none                                                                                              |

## 2. Real-binary — the assertions nothing else can make

**Windows CI** (`package (windows)` job in `pr.yml`) rebuilds node-pty from patched source and runs the `win32` suites against a real ConPTY: a real detached grandchild, a real job kill, and the inverse — a clean `exit` must leave backgrounded work alone.

**Real WSL distro** — not in CI; WSL isn't available on hosted runners.

```
ORCA_REAL_WSL_RUNNER_TEST=1 ORCA_WSL_TEST_DISTRO=Ubuntu-24.04 \
  pnpm vitest run src/main/wsl/wsl-runner.wsl.test.ts
```

It appends `sleep 60` to the distro's `~/.profile` and asserts the probe lane still answers inside its budget — **#14288 reproduced, not simulated** — then restores the profile. Also covers banner stripping, a script carrying quotes and `$` arriving byte-identical, WSLENV crossing, and guest cwd.

Run this before shipping a change to `src/main/wsl/`. It is the only evidence that the probe lane does what the workstream claims, and it has already gone stale once against a runner change while passing in CI, because CI skips it.
