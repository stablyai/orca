# QA Report — feat/linux-serve-auto-update round 3 (2026-09-07)

Regression-diff mode: delta since QA round 2 (`3c9e87315c`) through HEAD
(`8374328e6f`). Round 2 covered the branch surface through the census
handshake; this pass verifies the 4 commits landed after it: umask 077 +
sort -V comment fix (6c44f137f1), round-5 review fixes + relay harness race
repair (4ca0093756), security hardening + maintainability extraction
(49900d4b92), review-army test gaps (03667dabf0), and the bundle-parity
chunk fix (8374328e6f).

## Delta surface (3c9e87315c..HEAD)
- `src/main/cli/serve-update-helper-script.ts`: helper lock moved to
  `/run/lock/orca-serve-update-helper.lock` (symlink-truncation hardening);
  semver_higher strips build metadata; rollback removes VERSION_TARGET when
  no record predated the update.
- `src/main/cli/serve-update-helper-installer.ts` (+tests): jq/flock probes
  gate every install artifact; helper.json via mktemp+mv; sudoers rule pins
  zero arguments; newline/CR in any input field refused.
- `src/main/updater-artifact-cache-boundary.ts` (NEW): shared
  isInsideDirectory/isContainedInCache/decodeExpectedDigest/streamSha512,
  deduped from artifact-capture and linux-package-update-recovery.
- `src/main/serve-update-spool.ts` + `src/shared/serve-update-spool.ts`:
  DEFAULT_* constants, SERVE_UPDATE_HELPER_VERSION=1, dead readUpdateResult
  removed, 'timeout' verdict removed (null poll = timeout).
- `src/relay/subprocess-test-utils.ts` + `spawn-relay-stderr-tail.test.ts`:
  StringDecoder for the stderr tail + split-char regression test; cred-race
  harness sentinel-reject made unconditional and honest.
- `electron.vite.config.ts`: `serve-update-helper-installer` and
  `serve-update-spool` main entries for the CLI bundle.

## Functional lanes (all green on HEAD)
- Serve-update core suite (helper script, helper installer, spool, census,
  handoff failures incl. 8 new tests, artifact capture incl. 4 new tests,
  headless-serve install): 130 tests — 125 passed | 5 skipped.
- Remote-updater ring (remote-server-updater, rpc/errors): 39 passed.
- Full-suite run at load 21–38: 73,659+ passed, 60 failed across 16 files —
  15 re-ran green in isolation with the repo config (known rotating
  load-flake set: pty-transport family, WorktreeCard/AgentMap,
  automation-change-publication, cross-version-agent-session-wire,
  codex-tui-resume, transcript-watch-liveness, HtmlDocPreview,
  remote-runtime-shared-control-connection, useIpcEvents-terminal-create).
- 1 real failure caught and fixed (see Issues).

## Helper behavior probes (generated script, no docker needed)
- `bash -n` on generated helper (11809 B) and installer (14684 B): OK.
- Pre-parse rejection as non-root with empty spool: exit 0, verdict
  `{"phase":"rejected","attemptId":"","targetVersion":"","reason":"helper must run as root"}`
  written via mktemp path; request-leak check clean.
- `semver_higher` decision table from the generated script: 13/13 —
  includes 4 new build-metadata cases (tie, upgrade, downgrade,
  prerelease-metadata tie).
- Digest pipeline: standard-base64 sha512 decodes to 128 hex chars;
  URL-safe variant decodes to 0 bytes → caught by the 128-char length gate.
- jq verdict builders round-trip hostile payload strings (quotes, pipes):
  4/4 valid JSON.
- Census-continuation wait loop: census.ok → proceed; request vanished
  → cancel; expired deadline → fail-safe proceed (matches design).

## Issues found this round
1. **Fixed — CLI bundle chunk missing (8374328e6f).** The constants
   extraction made `src/cli/handlers/core.ts` import
   `src/main/serve-update-spool.ts`; the tsconfig include gained the file
   but `electron.vite.config.ts` did not, so the post-CLI-build step would
   have deleted the chunk at runtime. Caught by the
   `main-module-bundle-parity` guard during the full suite. Fixed: entry
   added, guard green, `build:cli` verified — chunk emitted and
   `out/cli/handlers/core.js` loads with the constants resolvable.

## Health
No branch-caused issues open. Health score: 100.
Deferred: Docker E2E execution is CI-gated ("Verify headless serve update
flow" in pr.yml); this machine has no docker. Helper root/systemctl paths
probed at contract level only (generated-script inspection + behavioral
probes above), same as rounds 1–2.
