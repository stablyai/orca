# TCC recovery detector validation — 2026-09-14

Scope: validate the proposed old-daemon-compatible transport and lifecycle mechanics, then
independently review the design. This is not a reproduction of TCC poisoning.

## Evidence

The harness launches its own isolated daemon process using `startDaemon`, `DaemonClient`, and
the production `createPtySubprocess` path. It creates fresh temporary runtime directories and
uses a compiled C executable as `shellOverride`, with no command input. The parent driver is
Node, not the installed Electron app. No existing user daemon was restarted, no user session
was touched, and no TCC permission or app bundle was modified.

Both runs explicitly reported the actual launch strategy: `direct` and `wrapped` respectively.

| Case | Helper result | Driver result | Cleanup |
| --- | --- | --- | --- |
| Readable directory with spaces, quote, dollar sign, backticks, newline | errno 0 | ok | No live or retained diagnostic session |
| Missing directory | errno 2 | ENOENT | No live or retained diagnostic session |
| Fixture directory chmod 000 | errno 13 | EACCES | No live or retained diagnostic session |
| Sleeping helper, client kills its session | No access verdict inferred | Not applicable | PID absence confirmed with ESRCH |
| Sleeping helper, no client kill | No access verdict inferred | Not applicable | Five-second helper alarm; PID absence confirmed |

Both daemon processes exited with code 0 after the harness shut them down. Fixture directory
permissions were restored after each run. The small temporary runtime directories were retained
for inspection; generated bundle removal does not affect the retained source.

The first harness iteration used the wrong event field (`payload.sessionId` instead of
`event.sessionId`); the second attempted to kill a session already reaped after normal exit.
Both harness issues were corrected before the successful runs. Normal cleanup tolerates only
the specific already-reaped error, not arbitrary failures.

Existing regression suites:

```sh
ORCA_BACKGROUND_LAUNCH=1 node_modules/.bin/vitest run --config config/vitest.config.ts \
  src/main/daemon/terminal-host-cwd-readability.test.ts \
  src/main/daemon/daemon-adoption-telemetry-event.test.ts \
  src/main/daemon/daemon-tcc-attribution.test.ts
```

Result: **3 files passed, 22 tests passed**.

Historical source check: `git show a7fda48fe3^:src/main/daemon/types.ts` and the corresponding
`pty-subprocess/shell-launch-plan.ts` confirmed that `shellOverride`, `env`, and Unix executable
launch support existed before cwd-readability telemetry. No historical binary was executed.

## Reproduce the transport checks

From this worktree, with host-compatible node-pty already available:

```sh
TCC_PROBE_BUILD_DIR=$(mktemp -d /tmp/orca-tcc-validation.XXXXXX)
clang -Wall -Wextra -O2 docs/plans/validation/tcc-directory-probe.c \
  -o "$TCC_PROBE_BUILD_DIR/directory-probe"
node_modules/.bin/esbuild docs/plans/validation/tcc-probe-validation.ts \
  --bundle --platform=node --format=cjs --packages=external \
  --outfile=docs/plans/validation/tcc-probe-validation.cjs
ORCA_BACKGROUND_LAUNCH=1 node docs/plans/validation/tcc-probe-validation.cjs \
  "$TCC_PROBE_BUILD_DIR/directory-probe"
ORCA_BACKGROUND_LAUNCH=1 ORCA_PROBE_WRAPPED=1 \
  node docs/plans/validation/tcc-probe-validation.cjs "$TCC_PROBE_BUILD_DIR/directory-probe"
```

The harness is a macOS experiment, not shipping code. Wrapped mode requests the production
login preflight; check the emitted actual strategy, since an unavailable login wrapper can
fall back to direct. The helper contains a test-only stall switch. Production packaging,
strict protocol parsing, queue limits, absolute deadlines, and crash-path cleanup need separate
implementation and tests.

## Independent review

A second agent reviewed the current protocol, shell launch, session listing, login wrapper,
and environment handling. It recommended using the tiny executable instead of a diagnostic
shell command, avoiding permanent success caching, and treating old-reader visibility and
late-create cleanup explicitly. Those findings are incorporated in the design.
Its final review also caught a trigger gap: checks must include failed terminal admission,
since permission denial can prevent creation. The rewritten design includes that correction.

## What this does not prove

- No known poisoned daemon was available in the validation fixture.
- chmod denial is POSIX permission behavior, not TCC; both tested sides were denied.
- The unsigned prototype does not establish the final signed helper's TCC attribution.
- A child can acquire different attribution under the login wrapper or executable identity.
- Current-daemon protocol execution plus historical source inspection is not old-binary proof.
- The helper alarm bounds an ordinary sleep, not an uninterruptible filesystem operation.
- No actual restart or rendered notice was tested; there is no production UI change yet.

The shipping gate remains: affected ordinary terminal denied, final packaged helper denied,
Electron main succeeds, then terminal/helper reads succeed after explicit restart.

---

# 2026-09-21 live evidence (production adopted daemon)

Scripts: [`live-2026-09-21/`](live-2026-09-21/). Full raw report (TCC rows, ps trees, logs) is
kept outside the repo at `~/orca-lanes/sta-7948-evidence-20260921/report.md` on the collecting
machine because it contains account paths.

## A. `access(2)` versus enumeration under TCC (`access_vs_scandir.py`)

Run as a launchd-owned `/usr/bin/python3` via `launchctl submit` (responsible pid = itself, no
TCC row). No `tccutil`, no window; the job was removed afterwards.

| Target | `access(R_OK\|X_OK)` | `stat` | `scandir` |
| --- | --- | --- | --- |
| `~/Documents` | **True** | ok | **EPERM** |
| `~/Library/Safari` (Full Disk Access class) | False | ok | EPERM |
| `~/Library/Mail` (Full Disk Access class) | False | ok | EPERM |
| `/tmp` | True | ok | ok |

The Documents run was executed twice with identical output. Conclusion: for the
SystemPolicyDocumentsFolder class, `accessSync(R_OK|X_OK)` passes while enumeration is denied, so
the daemon's current `cwdReadableByDaemon` verdict cannot observe the incident's failure.

## B. Production daemon, healthy state (`probe-daemon.mjs`)

Target: the live adopted daemon (pid 1232, protocol v36, spawned by app 1.4.207-adhoc while the
running app was 1.4.206; `spawnerExecPath` `/Applications/Orca.app/Contents/MacOS/Orca`). The
client speaks the real NDJSON protocol on the control and stream sockets with its own `clientId`,
creates one short-lived session per target with a `sta7948-evidence-*` session id, reads the
probe line, kills the session, and confirms it is absent from `listSessions`.

| Target | daemon `cwdReadableByDaemon` (accessSync) | login-wrapped shell `scandir` | control shell |
| --- | --- | --- | --- |
| `~/Documents` | true | ok (5 entries) | ok |
| `/tmp` | true | ok | ok |
| `~/Library/Safari` | true | ok (36 entries) | ok |

Five sessions were created; all exited 0; session count was 43 before and after. No process was
killed, signalled, or restarted; no window was shown.

## C. TCC responsible-process identity (`resp.c`)

`responsibility_get_pid_responsible_for_pid` (dlsym) for the process tree:

```
86248 -> 86248   Orca main
25437 -> 86248   Orca Helper (Renderer), child of Orca main      (probe control: children resolve to main)
86324 -> 86248   /usr/bin/log forked by Orca main                (probe control)
1232  -> 1232    production daemon (Orca Helper)
123   -> -1      /usr/bin/login (root; query not permitted)
162   -> 162     -/bin/zsh under that login
73362 -> 73362   -/bin/zsh under another login
73502 -> 73502   claude under that zsh
```

The daemon and every login-wrapped shell resolve to themselves, never to Orca main. Yet the
shells read `~/Library/Safari`, which only `com.stablyai.orca` holds Full Disk Access for
(`com.stablyai.orca.helper`, the daemon's own identifier, has no TCC row). The shells therefore
carry Orca's grant through the daemon, not through a pid-level link this API exposes. The
`ps` tree is `daemon -> /usr/bin/login -> -/bin/zsh -> agent CLIs`; the bash trampoline `exec`s
away and never appears.

## D. Other facts

- All 1734 `macos-tcc-pty-spawn` events in the local daemon log carry `strategy: "wrapped"`.
- `daemon_pty_cwd_denied` has never fired on this machine and no `cwdReadableByDaemon=false`
  appears in `daemon.log` or `main.trace.ndjson`; per section A this is uninformative for the
  Documents class.
- `/Applications/Orca.app` and `Orca Helper.app` are signed Developer ID, TeamIdentifier
  `6CX3WHS9HZ`, hardened runtime.

## What this still does not prove

- The broken state was not observed; sections B and C describe the healthy state only.
- Whether the daemon's in-process `opendir` and its shells' reads diverge when the lineage is
  broken (gate G1 in the design).
- Whether restart alone recovers, or restart plus `tccutil reset` and re-allow is required (G1).

---

# PostHog field data (queried 2026-09-21, 21-day window)

`daemon_pty_cwd_denied` fires only on proven divergence: daemon `accessSync` denied, app
`accessSync` succeeded, macOS only (#18043, shipped 2026-09-01).

| cwd_class | app_version_match | events | users |
| --- | --- | ---: | ---: |
| documents | different | 5,674 | 863 |
| desktop | different | 2,379 | 404 |
| outside-home | different | 480 | 58 |
| downloads | different | 369 | 79 |
| documents | same | 113 | 33 |
| desktop | same | 113 | 25 |
| other-home | different | 25 | 8 |

- Distinct denied users: 1,438 (1,374 in documents/desktop/downloads). Users who adopted a
  different-version daemon in the window: 50,876. Denial rate among them: 2.8%.
- Persistence: 910 users denied on one day, 413 on 2–3 days, 115 on 4 or more days.
- Daily denied users ramped from single digits on 2026-09-07 to about 300/day by 2026-09-16 as
  the telemetry release rolled out, then about 110–135/day over the weekend.
- Remedy signal: among denied users with a later same-version `daemon_adopted` (a daemon forked
  by the current app), 151 had no further denial and 68 were denied again (about 69% / 31%).
  1,219 had no same-version adoption inside the window.
- `daemon_adopted` with `tcc_attribution=severed` (the existing notice's trigger): 45 users. The
  cwd-denial population is about 30 times larger.

Consequence: the daemon's existing `accessSync` verdict does observe the failure in the field.
The grant-less launchd probe (section A above) shows a second TCC mode on `~/Documents` where
`access()` passes and `opendir` fails; the two modes are different TCC states, and enumeration
covers both.
