# Verifying the W1–W3 Windows/WSL work

Three layers of coverage, because each catches what the others structurally cannot.

## 1. Unit — runs everywhere, every PR

| Suite | Pins |
|---|---|
| `src/main/wsl/wsl-runner.test.ts` | Separator, lane selection, fencing, WSLENV, guest cwd, script interpreter, budget split, refusal on unresolved PATH |
| `src/main/wsl/wsl-guest-environment.test.ts` | Burst collapse, per-distro isolation, malformed-payload rejection, transient vs permanent, retry windows, joiner budget |
| `src/main/wsl/wsl-w1-w3-contract.test.ts` | The W1→W3 chain end to end: absolute `wsl.exe`, argv array, bounded call, no `--`, script byte-identical, WSLENV, no shell on probe, login PATH still applied |
| `src/shared/source-scan/source-tree-scan.test.ts` | The guard helpers. A guard that under-reports is worse than none |

## 2. Ratchets — the goalposts, enforced continuously

| Guard | Measures |
|---|---|
| `wsl-invocation-boundary.test.ts` | Files spawning `wsl.exe` outside the runner, plus bash-only payloads that fail to declare `shell: 'bash'` |
| `windows-console-visibility.test.ts` | Direct child-process calls missing `windowsHide` |
| `child-process-import-boundary.test.ts` | Files importing `child_process` outside the chokepoint |
| `wsl-exec-mode-separator.test.ts` | The banned `--` separator |
| `pty-descendant-termination-job-coverage.test.ts` | Every sweep passes `terminateOwnedTree` |

Each fails on a **new** offender *and* on a **stale** entry, so the count can only fall. Verify a guard by planting a violation and watching it get named — that step has found a bug in the guard itself three times.

## 3. Real-binary — the assertions nothing else can make

**Windows CI** (`package (windows)` job in `pr.yml`) rebuilds node-pty from patched source and runs the `win32` suites against a real ConPTY: a real detached grandchild, a real job kill, and the inverse — a clean `exit` must leave backgrounded work alone.

**Real WSL distro** — not in CI; WSL isn't available on hosted runners.

```
ORCA_REAL_WSL_RUNNER_TEST=1 ORCA_WSL_TEST_DISTRO=Ubuntu-24.04 \
  pnpm vitest run src/main/wsl/wsl-runner.wsl.test.ts
```

It appends `sleep 60` to the distro's `~/.profile` and asserts the probe lane still answers inside its budget — **#14288 reproduced, not simulated** — then restores the profile. Also covers banner stripping, a script carrying quotes and `$` arriving byte-identical, WSLENV crossing, and guest cwd.

Run this before shipping a change to `src/main/wsl/`. It is the only evidence that the probe lane does what the workstream claims, and it has already gone stale once against a runner change while passing in CI, because CI skips it.

## Known gaps in the windowsHide guard

Recorded rather than implied, because a guard that looks complete is worse than one with a documented edge.

- **`fork` is not scanned.** Node forwards `windowsHide` to spawn at runtime, but `ForkOptions` does not declare it, so the two live sites — `main/daemon/daemon-init.ts` and `main/plugins/plugin-host-process.ts` — cannot be fixed without a cast. Both are console-subsystem children on Windows.
- **The allowlist is file-granular, so an allowlisted file is blind.** ~18 of its entries are false positives (`RegExp.prototype.exec`, `provider.exec`, and files the lexer desynced on), and each carries a standing pre-approval for a real regression in that file. Those entries also cannot be retired by fixing code, so the list cannot reach zero as written. Making it call-granular is the fix.
- **`stripComments` has no desync report.** The fail-closed check runs on already-stripped text, so a regex literal containing a slash-star can still swallow code silently. No occurrence in `src/` today.

### Verifying a guard change

Plant a violation and watch it fail. Every guard fix in this workstream that was verified only by reading was wrong — three consecutive attempts at an exact lexer each shipped a desync that *reduced* the offender count, which read as progress. Plant at least: a plain call, one in a template-literal-heavy file, one in a regex-heavy file, `windowsHide: false`, a ternary first argument, and a renamed import.
