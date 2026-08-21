# Windows Test Suite Remediation Plan

## Status

Evidence gathered on 2026-08-20 from a full `vitest run` on Windows 11 Pro
(Node 24.16.0, Git 2.54.0.windows.1, pnpm 10.24.0).

```
Test Files  99 failed | 5876 passed | 65 skipped (6040)
     Tests  289 failed | 55257 passed | 816 skipped (56401)
  Duration  2442s
```

Verified identical on `main` and on `Sylen00/pet-overlay-animations` — the same
99 files, the same 289 tests. None of this comes from feature work; it is
accumulated platform rot.

> **Closed (2026-08-21): 0 failures.** 6040 files / 56158 tests pass on Windows.
> The baseline is now `{}`, so any failure is a regression. See
> [Run 2 results](#run-2-results--2026-08-21) and
> [Final result](#final-result--2026-08-21) for what each remaining failure
> turned out to be — and why the first diagnosis of the last three was wrong
> every time.

## Why this exists

`.github/workflows/pr.yml` runs the full suite **only on `ubuntu-latest`**. The
single `windows-2022` job (`package_windows`) runs exactly seven hand-picked
files under "Test Windows-specific boundaries", then packages the app.

That means **no Windows regression in the other 6033 test files has ever been
visible in CI**. Every failure catalogued below was merged green. Fixing the
289 without closing that gap guarantees the same list regrows.

## The decision rule (read before touching anything)

Every failing test resolves to exactly one of three verdicts. Recording the
verdict is mandatory; it is what keeps this from becoming a `skipIf` sweep that
hides real defects.

| Verdict | Meaning | Action |
| --- | --- | --- |
| **P — Product bug** | Orca genuinely misbehaves on Windows. The test is right. | Fix production code. Highest value. |
| **T — Test portability bug** | Orca is fine; the test hardcodes POSIX assumptions. | Fix the test. Never the product. |
| **C — Capability gap** | The operation cannot work in this environment at all (privilege, missing binary). | Gate on a **detected capability**, never on `process.platform`. |

**Hard rule:** `it.skipIf(process.platform === 'win32')` is forbidden as a fix
unless the behaviour under test is genuinely POSIX-only *by design*. A
platform skip on a capability problem silently disables the test on CI runners
where the capability *is* present. Gate on the capability itself.

**Hard rule:** never change a production assertion to match Windows output
without first proving the Windows output is correct. Several clusters below are
ambiguous — resolve the ambiguity before editing.

## Reproduce

```bash
# full sweep, ~41 min
node_modules/.bin/vitest run --config config/vitest.config.ts > /tmp/suite.log 2>&1

# strip ANSI so greps work
sed 's/\x1b\[[0-9;]*m//g' /tmp/suite.log > "$TEMP/suite-clean.log"

# failing files, most failures first
grep -oE "^ FAIL +[^ ]+" "$TEMP/suite-clean.log" | awk '{print $2}' \
  | sed 's/:.*//' | sort | uniq -c | sort -rn
```

`pnpm` is not on PATH in this shell; it resolves through corepack. Scripts that
shell out to `pnpm` need a shim:

```bash
mkdir -p "$TEMP/pnpmshim"
printf '@echo off\r\ncorepack pnpm %%*\r\n' > "$TEMP/pnpmshim/pnpm.cmd"
export PATH="$PATH:$TEMP/pnpmshim"
```

---

## Root cause catalogue

Each cluster below is proven, not inferred. The reproduction command is the
evidence.

### Cluster A — Symlink privilege (14 files, ~61 tests) · verdict **C**

```
Error: EPERM: operation not permitted, symlink 'X' -> 'Y'
```

Windows refuses `CreateSymbolicLink` without Developer Mode or elevation.
Proven:

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');
const d=fs.mkdtempSync(p.join(os.tmpdir(),'sl-'));
try{fs.symlinkSync(d,p.join(d,'ln'));console.log('symlink OK')}catch(e){console.log('symlink',e.code)}
try{fs.symlinkSync(d,p.join(d,'j'),'junction');console.log('junction OK')}catch(e){console.log('junction',e.code)}"
# → symlink EPERM
# → junction OK
```

Developer Mode is **off** on this machine
(`HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock` →
`AllowDevelopmentWithoutDevLicense` absent). GitHub's `windows-2022` runners are
elevated, so these tests would pass in CI.

The repo already knows the portable idiom — `src/main/git/repo-detection.test.ts`
and `status-discard-symlink.test.ts` use
`symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')`.
Junctions cover directory links; **file** symlinks have no junction equivalent
and need the capability gate.

Files:

```
19  src/main/ipc/folder-repo-git-upgrade.test.ts
 9  src/main/ipc/worktree-symlinks.test.ts
 9  src/main/git/status-shared-symlinks.test.ts
 7  src/main/source-control/hosted-review-creation-shared-symlinks.test.ts
 3  src/relay/fs-handler.test.ts
 3  src/main/agent-hooks/installer-utils.test.ts
 2  src/main/runtime/orca-runtime-files-terminal-artifact-io.test.ts
 2  src/main/runtime/orca-runtime-files-terminal-artifact-grants.test.ts
 2  src/main/local-downloaded-folder-promotion.test.ts
 1  src/relay/subprocess.test.ts
 1  src/main/skills/skill-share-preparation-service.test.ts
 1  src/main/local-builds/local-build-candidate.test.ts
 1  src/main/git/worktree-include-file.test.ts
 1  src/main/claude-accounts/runtime-auth-service-materialization.test.ts
```

`src/main/ipc/worktree-symlinks.test.ts` fails one step later with
`ENOENT ... lstat` — it is the same cause, surfacing after the failed link.

### Cluster B — `os.devNull` as a Git config path (1 file, ~25 tests) · verdict **T**

```
Error: Command failed: git init -q
```

`src/main/git/worktree-shared-directories.test.ts:20` sets
`GIT_CONFIG_GLOBAL: devNull`. On Windows `os.devNull` is `\\.\nul`, which MSYS
Git rejects. Proven:

```bash
node -e "const {execFileSync}=require('child_process');const {mkdtempSync}=require('fs');
const {tmpdir,devNull}=require('os');const {join}=require('path');
const d=mkdtempSync(join(tmpdir(),'g-'));
try{execFileSync('git',['init','-q'],{cwd:d,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:devNull}});console.log('devNull OK')}
catch(e){console.log('devNull FAILED:',String(e.stderr).trim())}
for(const v of ['NUL',join(d,'no-such-gitconfig')]){
  try{execFileSync('git',['init','-q'],{cwd:d,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:v}});console.log(v,'OK')}catch(e){console.log(v,'FAILED')}}"
# → devNull FAILED: fatal: unable to access '//./nul': Invalid argument
# → NUL OK
# → <tmp>/no-such-gitconfig OK
```

Prefer a nonexistent path inside the test's own temp dir — it is portable
without a platform branch and cannot collide with a real device name. The test
also masks the real error with `stdio: 'ignore'`; switch to `'pipe'` and include
stderr in the thrown message while fixing this.

Audit for the same pattern elsewhere before closing:

```bash
grep -rn "devNull" src/ config/ --include=*.ts --include=*.mjs
```

### Cluster C — Shebang + CRLF breaks the Vite transform (3 files) · verdict **T**

```
SyntaxError: Invalid or unexpected token   (no file, no line)
```

`node --check` passes on all three modules. Isolated by bisection: importing
the module under test from *any* test file reproduces it. Converting the module
to LF makes it pass. The three affected modules all begin
`#!/usr/bin/env node\r\n`; Vite's shebang stripping leaves the stray `\r`.

```
config/scripts/resolve-7za-path.test.mjs        → config/scripts/resolve-7za-path.mjs
config/scripts/trim-windows-icon-source.test.mjs → config/scripts/trim-windows-icon-source.mjs
config/scripts/regenerate-xterm-patches.test.mjs → config/scripts/regenerate-xterm-patches.mjs
```

`.gitattributes` already pins other `config/scripts/*.mjs` to `text eol=lf`.
The fix is to extend that to every shebang-bearing `.mjs`. Find them all:

```bash
for f in config/scripts/*.mjs; do
  head -1 "$f" | grep -q '^#!' && printf '%s %s\n' \
    "$(head -1 "$f" | grep -c $'\r')" "$f"
done | grep '^1'
```

Then re-normalise the working tree (`git add --renormalize .`) — adding the
attribute alone does not rewrite files already checked out with CRLF.

### Cluster D — `spawnSync` of a `.cmd` without a shell (1 file, ~2 tests) · verdict **T/P**

```
Error: spawnSync ...\node_modules\.bin\oxlint.cmd EINVAL
```

Node refuses to spawn `.cmd`/`.bat` without `shell: true` (CVE-2024-27980
mitigation). `config/scripts/mobile-pairing-qrcode-import-plugin.test.mjs:25`
hits it.

Two sibling *production* scripts had the identical defect and were fixed in
commit `a25372e4ac` — `check-react-doctor-changed.mjs` and
`check-changed-code-quality.mjs`, both of which meant **two code-quality gates
had never run on Windows at all**. Audit the rest:

```bash
grep -rn "\.cmd'" config/scripts/*.mjs src/ --include=*.ts | grep -v "shell"
```

Known remaining candidates carrying the pattern (verify whether each is
reachable before editing — `build-native-for-platform.mjs` prefers
`process.execPath` and never reaches its `.cmd` branch in practice):
`build-mac-local.mjs`, `build-native-for-platform.mjs`, `ensure-native-runtime.mjs`
(already correct — use it as the reference).

### Cluster E — `/bin/sh` assumed present (4 files, ~30 fails) · verdict **T**

```
Error: spawn /bin/sh ENOENT
```

`src/main/ssh/ssh-relay-upload-stage-commands.test.ts:73` calls
`spawnSync('/bin/sh', ['-c', ...])` unconditionally; the file already has a
PowerShell branch at line 39, so the intent was portability and the fallback
simply escaped it. `spawnSync` then returns `status: null`, which surfaces as
the file's `expected null to be +0` failures — those 7 belong to this cluster,
not to a generic assertion bucket.

Also affects `src/main/ephemeral-vm-runtime-service.test.ts`,
`src/main/ipc/ephemeral-vm.test.ts` (fixture `scripts/start.js` launched through
`/bin/sh`), and `src/main/ssh/ssh-remote-commands.test.ts`. One of the run's two
unhandled rejections is this same `spawn /bin/sh ENOENT`.

### Cluster F — Deleting a directory with an open handle (1 file, ~11 tests) · verdict **T**

```
Error: EPERM, Permission denied: \\?\...\exit-provenance-XXXXXX
```

`src/main/runtime/exit-provenance-audit.test.ts` opens an `OrchestrationDb` per
test (`createDb`, line 26) and never closes it; `afterEach` then `rmSync`s the
directory. POSIX allows unlinking open files; Windows does not.

Fix: track the db handles and close them in `afterEach` before removing the
directory. Check whether `OrchestrationDb` exposes a close/dispose method
first — if it does not, that absence is itself worth a look (verdict may become
**P**: a database with no way to release its file handle is a leak on every
platform, merely invisible on POSIX).

### Cluster G — POSIX path literals in tests (33 files, ~95 fails) · verdict **T**, some **P**

Split into G1 (2 files, 26 — phase 5), G2 (29 files, 57 — phase 6) and G3
(2 files, 12 — phase 6). G1 is mechanical and separated out so the large,
judgement-heavy G2/G3 work does not block it.

The largest and most delicate cluster. Three distinct shapes:

**G1 — the test builds a path with `join(sep, ...)` and asserts a `/`-string.**
`src/main/ipc/worktree-base-directory-watcher.test.ts:58` does
`join(sep, ...parts)` → `\workspace\worktrees`, while the poller registry is
keyed on the literal the production code produced. Result:

```
Error: No poller callback for \workspace\worktrees   (28 occurrences, 20 tests)
```

Sibling file `worktree-base-directory-event-filter.test.ts` (6 tests) shares it.
This is a **test** bug: the mock's key and the production key are derived
differently.

**G2 — the assertion hardcodes a POSIX absolute path.**

```
expected '\agents\.pi\agent\sessions' to be '/agents/.pi/agent/sessions'
expected null to be '/Users/example/.codex'
expected 'file:///C:/repo/a%20b.png' to be 'file:///repo/a%20b.png'
```

Affected: `session-scanner-values.test.ts` (5), `codex-session-resume-home.test.ts`
(9), `clipboard-file-copy.test.ts` (4), `ssh-g-config-resolution.test.ts` (4),
`session-scanner.test.ts` (3), and ~20 files with 1–2 each.

**Do not blindly rewrite these to backslashes.** Some are genuinely
platform-independent contracts. `normalizeAgentSessionsDir`
(`src/main/ai-vault/session-scanner-values.ts:142`) receives *remote/WSL* paths
that must stay POSIX even when Orca runs on Windows — forcing `path.join` there
would be a **product regression**. For each, decide: is this path local
(platform-native) or remote/WSL (always POSIX)? The answer determines whether
the test or the production code is wrong.

`src/main/codex/codex-session-resume-home.ts` routes through
`normalizeRuntimePathForComparison` (`src/shared/cross-platform-path.ts:41`),
which lowercases and folds separators **only for paths it recognises as
Windows-absolute**. A POSIX literal like `/Users/example/.codex` is left alone,
so the comparison should still work — the `expected null` failures suggest a
real gap in that detection. Treat this one as candidate **P**.

**G3 — path prefix/root mismatch.**

```
- "\tmp\orca-...\.gemini\tmp\project-a\session-1.json"
+ "C:\tmp\orca-...\.gemini\tmp\project-a\session-1.json"
  "outcome": "rejected", "reason": "path-outside-known-roots"
```

`session-delete.test.ts` (7) and `session-delete-target.test.ts` (5): the
fixture home is built as `/tmp/...` which resolves to `C:\tmp\...`, while the
"known roots" check compares against the undriven form. **This is a security
boundary** (`path-outside-known-roots`) — a root-containment check that behaves
differently on Windows is candidate **P** and must be resolved before the test
is touched.

### Cluster H — Platform capability detection (4 files, ~16 fails) · verdict **P or by-design**

```
- "allowPtyFallback": true,     + "allowPtyFallback": false
- "state": "success",           + "state": "unknown"
- "C:\Windows\System32\OpenSSH\ssh.exe"
+ "C:\Program Files\Git\usr\bin\ssh.exe"
```

`service-account-target-selection.test.ts` (5), `codex-fetcher.test.ts` (2),
`linux-terminal-orca-cli-shim.test.ts` (2), `ssh-system-fallback.test.ts` (7).

The ssh one is the clearest: the test expects the system OpenSSH at
`C:\Windows\System32\OpenSSH\ssh.exe`, but discovery picks Git's bundled
`ssh.exe` first. Which is *correct* is a product question — Git's ssh and the
system ssh differ in config handling. Answer it before editing either side.

The `allowPtyFallback: false` group is likely the Linux-only shim being probed
on Windows; those may be legitimately by-design and want a capability gate.

### Cluster I — Timeouts and watchers (3 files, ~12 tests) · verdict **P or T**

```
Error: Test timed out in 30000ms.
Error: timed out waiting for condition
```

`filesystem-watcher-local-unsubscribe.test.ts` (7),
`native-chat.test.ts` (3), `pty-subprocess.test.ts` (2).

Windows filesystem event delivery differs from inotify — coalescing, delays,
and no event for some operations. These need individual investigation; a bare
timeout bump would hide a real product problem. The second unhandled rejection
of the run points here: `TypeError: Cannot read properties of undefined
(reading 'onData')` at `src/main/daemon/pty-subprocess.ts:983` — a production
file, so candidate **P**.

### Cluster K — Untriaged remainder (34 files, ~47 fails) · verdict **?**

The tail: files whose one or two failures did not match any signature proven
above. They are **not** a category — they are the work that has not been read
yet. The appendix lists every one.

Do not treat this cluster as low value because the counts are low. It is the
most likely place for a genuine **P** to be hiding, precisely because nothing
about it was mechanical enough to pattern-match. Known samples:

```
src/shared/node-markdown-document-discovery.test.ts   - "docs/guide.mdx"        (ordering or separator)
src/main/cli/windows-user-path-registry.test.ts        Windows-specific by name — a failure here is suspicious
src/main/durable-file-write-syscall-proof.test.ts      fsync/rename semantics differ on Windows
src/main/bitbucket/credential-store.test.ts            credential storage backend differs per platform
src/relay/rotating-log-writer.test.ts                  file rotation with open handles — cf. Cluster F
```

`windows-user-path-registry` deserves attention first: a test named for Windows
failing *on* Windows cannot be a portability oversight.

**Triage procedure**, one file at a time:

1. Run it alone and read the whole failure, not just the first line.
2. Assign it to an existing cluster if it fits — several will land in A, E, F
   or H on inspection.
3. If it fits none, give it a verdict (**P**/**T**/**C**) and fix it there and
   then. Do not batch.
4. Update the appendix row.

**Gate K (after every file):** the file passes, and
`node config/scripts/windows-suite-baseline.mjs --compare` is clean. A file
that turns out to be **P** additionally needs `tsc` node + web and a run of the
production module's own test file.

### Cluster J — Non-ASCII repo path (1 file) · verdict **T**

```
tar: C\:\\Users\\Sylen\\orca\\workspaces\\orca\\Modificação-de-Pets\tests\\e2e\\...
    Cannot open: No such file or directory
```

`tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` builds
`sh -c "git archive ... | tar -x -C \"<path>\""` in
`tests/e2e/cross-version-wire/release-checkout.ts:231`. The workspace path
contains `ç` and the quoting mangles under MSYS.

Note this reproduces only because *this* workspace directory is named
`Modificação-de-Pets`. It would also break any user path with a space or
non-ASCII character, so it is worth fixing regardless — but it will not
reproduce on a plain ASCII checkout. Verify by cloning to an ASCII path before
concluding.

---

## Work plan

Ordered by **evidence strength × cost**. Cheap-and-proven first, so the
baseline shrinks early and later clusters are easier to read.

Every phase ends with a **verification gate**. Do not start the next phase
until the gate passes. If the gate reveals a new failure, fix it inside the
current phase — that is the point of the gate.

### Phase 0 — Instrument the baseline (do this first)

Nothing else is trustworthy without it.

1. Write `config/scripts/windows-suite-baseline.mjs` that runs the suite,
   strips ANSI, and emits a sorted `file → failing-test-count` JSON.
2. Commit the current output as `docs/reference/windows-suite-baseline.json`.
3. Add a `compare` mode that diffs a fresh run against the committed baseline
   and exits non-zero **only on files that got worse or are newly failing**.

**Gate 0:** `node config/scripts/windows-suite-baseline.mjs --compare` exits 0
against an unchanged tree. Confirm it correctly reports a regression by
temporarily breaking one test.

> Why first: 289 failures cannot be tracked by eye, and every later phase needs
> to prove it fixed its own cluster without disturbing another.

### Phase 1 — Cluster C (shebang CRLF), 3 files

Smallest, fully proven, zero ambiguity. Good calibration for the loop.

1. Enumerate shebang-bearing `.mjs` under `config/scripts/`.
2. Add `text eol=lf` entries to `.gitattributes` for all of them.
3. `git add --renormalize .` and confirm the working tree changed.

**Gate 1:**
```bash
node_modules/.bin/vitest run --config config/vitest.config.ts config/scripts/
```
The three `SyntaxError` files pass. Baseline compare shows −3 files, no new
failures. **Also re-run the three modules' own consumers** — these scripts are
invoked during packaging, so a line-ending change must not alter behaviour:
`node config/scripts/resolve-7za-path.mjs --help` (or the nearest smoke path).

### Phase 2 — Cluster B (`os.devNull`) + Cluster D (`.cmd` spawn)

1. Replace the `devNull` Git-config trick with a nonexistent temp path, and
   switch `stdio: 'ignore'` → `'pipe'` so future failures name themselves.
2. Grep for both patterns repo-wide; fix every reachable instance.
3. For each `.cmd` site, first prove it is reachable on Windows before adding
   `shell:` — record the ones that are not, and say so in the commit.

**Gate 2:**
```bash
node_modules/.bin/vitest run --config config/vitest.config.ts \
  src/main/git/worktree-shared-directories.test.ts \
  config/scripts/mobile-pairing-qrcode-import-plugin.test.mjs
grep -rn "devNull" src/ config/ --include=*.ts --include=*.mjs
grep -rn "\.cmd'" config/scripts/*.mjs src/ --include=*.ts | grep -v shell
```
Both files green, greps return only justified hits. Baseline compare clean.

### Phase 3 — Cluster A (symlink capability), 14 files

The largest single win, and the one most at risk of being papered over.

1. Add a shared capability probe. It must **detect**, not assume:
   ```ts
   // one probe per process, cached
   export function canCreateFileSymlink(): boolean
   export function canCreateDirSymlink(): boolean   // junction counts
   ```
   Name it for what it holds (`symlink-capability.ts`), not `test-utils`.
2. Directory links: switch to the existing repo idiom
   (`'junction'` on win32) wherever a junction is semantically equivalent.
   This *fixes* rather than skips, and is preferred everywhere it applies.
3. File links: gate with `it.skipIf(!canCreateFileSymlink())`. On an elevated
   CI runner the capability is present and the test runs — which is exactly
   why the gate must be the capability and not `platform === 'win32'`.
4. Re-check `worktree-symlinks.test.ts`'s downstream `lstat ENOENT` failures
   disappear once the links are created.

**Gate 3:** all 14 files either pass or skip **with a capability reason**, and:
```bash
# prove the gate does not over-skip: on a machine WITH the capability the
# skipped tests must run. Simulate by forcing the probe true and confirming
# the tests execute (they may then fail for other reasons — record those).
```
Baseline compare shows −14 files. **Do not accept a green gate that skipped
everything** — count skips and justify each.

> Consider recommending Developer Mode be enabled on the dev machine
> (`Settings → System → For developers`). It resolves all 61 tests with no code
> change and matches CI. The capability gate is still needed for machines
> without it.

### Phase 4 — Cluster E (`/bin/sh`) + Cluster F (open db handle)

1. `/bin/sh`: extend the existing PowerShell branch in
   `ssh-relay-upload-stage-commands.test.ts` to cover the fallback path.
   For the ephemeral-VM fixtures, launch the script with `process.execPath`
   directly instead of routing through a shell.
2. `exit-provenance-audit.test.ts`: close each `OrchestrationDb` in `afterEach`
   before `rmSync`. **First check whether a close method exists** — if not,
   escalate to **P** and add one.

**Gate 4:**
```bash
node_modules/.bin/vitest run --config config/vitest.config.ts \
  src/main/runtime/exit-provenance-audit.test.ts \
  src/main/ephemeral-vm-runtime-service.test.ts \
  src/main/ipc/ephemeral-vm.test.ts \
  src/main/ssh/ssh-relay-upload-stage-commands.test.ts \
  src/main/ssh/ssh-remote-commands.test.ts
```
All green, **and the run reports zero unhandled errors** — one of the two
unhandled rejections is the `/bin/sh` spawn and must be gone.

### Phase 5 — Cluster G1 (poller path keys), 2 files, ~26 tests

Self-contained and mechanical once understood: make the mock registry key and
the production key derive from the same function.

**Gate 5:** both watcher files green; baseline compare clean. Then re-run the
whole `src/main/ipc/` directory — these files mock a shared module and a
change there can leak sideways.

### Phase 6 — Cluster G2 + G3 (path expectations), 31 files · **the careful one**

This phase decides product questions. Budget the most time here and resist
batching.

For each file, in this order:

1. Classify the path: **local** (must be platform-native) or **remote/WSL**
   (must stay POSIX). Write the answer in the commit message.
2. If local and the test hardcodes `/`, fix the test.
3. If remote and production forced `path.join`, fix production (**P**).
4. **G3 first, not last** — `session-delete*.test.ts` touch
   `path-outside-known-roots`, a containment boundary. If root containment
   behaves differently on Windows, that is a security-relevant product bug and
   outranks everything else in this plan. Resolve it before the cosmetic ones.
5. Investigate `codex-session-resume-home` as candidate **P**:
   `normalizeRuntimePathForComparison` only folds paths it detects as
   Windows-absolute, so a POSIX input should pass through — the `expected null`
   results suggest the detection or the trusted-home comparison has a gap.

**Gate 6, run after *every* file, not at the end of the phase:**
```bash
node_modules/.bin/vitest run --config config/vitest.config.ts <the file>
node config/scripts/windows-suite-baseline.mjs --compare
```
Plus, after any production change:
```bash
node_modules/.bin/tsc --noEmit -p config/tsconfig.node.json
node_modules/.bin/tsc --noEmit -p config/tsconfig.tc.web.json
```
A production edit in this phase can regress Linux/macOS. Any change to a
shared path helper (`src/shared/cross-platform-path.ts` especially) requires
running its own test file **and** every consumer before moving on.

### Phase 6b — Cluster K triage, 34 files, ~47 fails

Everything the signatures did not catch. Follow the triage procedure in
Cluster K above, **one file at a time**, and start with
`src/main/cli/windows-user-path-registry.test.ts` — a Windows-named test
failing on Windows is the strongest **P** candidate in the whole run.

Expect a meaningful share of these to fold into clusters already fixed by this
point (A, E, F, H); those become quick. The residue is where the unknown
product bugs live.

**Gate 6b, after every file:**
```bash
node_modules/.bin/vitest run --config config/vitest.config.ts <the file>
node config/scripts/windows-suite-baseline.mjs --compare
```
Plus `tsc` node + web after any production edit. Update the appendix row for
the file before moving on — the appendix is the progress ledger for this phase.

### Phase 7 — Cluster H (capability detection), 4 files

Product questions again, one at a time:

- Which `ssh.exe` *should* Orca prefer on Windows? Decide, document the reason
  in the code, then align the test.
- Is `allowPtyFallback: false` correct on Windows, or is the probe wrong?
- Is `linux-terminal-orca-cli-shim` meaningful on Windows at all, or should it
  be capability-gated?

**Gate 7:** per file as in Gate 6. Additionally, for the ssh decision, check
`docs/reference/` for an existing statement of intent before inventing one, and
add one if it is missing.

### Phase 8 — Cluster I (timeouts/watchers), 3 files

Hardest to diagnose; deliberately last so the log is quiet by now.

1. Start with the unhandled rejection at `src/main/daemon/pty-subprocess.ts:983`
   (`proc.onData` on undefined) — it is production code and may be causing
   downstream flakiness across several files.
2. For the watcher tests, determine whether Windows genuinely delivers no
   event, delivers it late, or coalesces. **A timeout bump is only acceptable
   after proving the event does arrive.**

**Gate 8:** the three files green with no bumped timeout that lacks a written
justification; zero unhandled errors in a full run.

### Phase 9 — Cluster J (non-ASCII path), 1 file

Fix the quoting in `release-checkout.ts:231`. Verify by running the test from a
path containing both a space and a non-ASCII character.

**Gate 9:** passes from `Modificação-de-Pets` *and* from a plain ASCII clone.

### Phase 10 — Close the CI gap (the part that makes this stick)

Without this, the list regrows.

1. Add a `windows-2022` job to `.github/workflows/pr.yml` running the full
   suite.
2. Land it **non-blocking first** (`continue-on-error: true`) with the baseline
   comparison from Phase 0 as its check, so it reports regressions without
   blocking merges while the tail is worked down.
3. Flip it to blocking once the baseline reaches zero.
4. Note the runner is elevated, so Cluster A's tests will *run* there — the
   capability gate from Phase 3 is what makes that safe.

**Gate 10:** open a throwaway PR that deliberately breaks one Windows-only
behaviour and confirm the job catches it.

---

## Final review checklist

Run this after Phase 10, and again before declaring the work done.

- [ ] Full suite on Windows: `0 failed`, or every remaining failure has a
      recorded verdict and a linked issue.
- [ ] Full suite on Linux still green — **run it**, do not assume. Several
      phases touch shared production code.
- [ ] `grep -rn "skipIf(process.platform === 'win32')" src/ | wc -l` has not
      grown beyond the entries that existed at the start, minus any this work
      removed. Every new skip gates a *capability*, not a platform.
- [ ] Zero unhandled errors in a full run (started at 2).
- [ ] Every **P** verdict produced a production fix, not a test edit.
- [ ] Every **C** verdict gate was proven to *un*-skip when the capability is
      present.
- [ ] `docs/reference/windows-suite-baseline.json` updated and at zero.
- [ ] The Windows CI job is blocking.
- [ ] `tsc` node + web + cli clean; `oxlint` clean; max-lines ratchet clean.
- [ ] `node config/scripts/check-changed-code-quality.mjs` passes — it now runs
      on Windows for the first time (fixed in `a25372e4ac`), so treat its first
      findings as new information.

## Sizing

| Phase | Files | Tests | Confidence | Risk |
| --- | --- | --- | --- | --- |
| 0 Baseline | — | — | high | none |
| 1 Shebang CRLF | 3 | 3 | proven | none |
| 2 devNull + .cmd | 2 | ~27 | proven | low |
| 3 Symlink capability | 14 | ~61 | proven | medium — over-skipping |
| 4 /bin/sh + db handle | 5 | ~41 | proven | low |
| 5 Poller keys (G1) | 2 | ~26 | high | low |
| 6 Path expectations (G2+G3) | 31 | ~69 | mixed | **high — product decisions** |
| 6b Untriaged remainder (K) | 34 | ~47 | **unknown** | **high — unread** |
| 7 Capability detection | 4 | ~16 | mixed | medium |
| 8 Timeouts/watchers | 3 | ~12 | low | medium |
| 9 Non-ASCII path | 1 | 1 | proven | none |
| 10 CI gap | — | — | high | none |

Phases 1–5 and 9 cover 57 files / ~168 fails and are largely mechanical —
every one has a proven root cause and a known fix shape.

Phases 6, 6b, 7 and 8 are the real work: 42 files / ~144 fails, each needing a
judgement about what Orca *should* do on Windows. Phase 6b is the only phase
entering with an unknown verdict, and should be expected to surface the
product bugs this exercise is actually worth doing for.

## What this plan deliberately does not do

- It does not bulk-apply `skipIf(win32)`. That would turn 289 visible failures
  into 289 invisible ones.
- It does not adjust assertions to whatever Windows currently prints. Several
  clusters are candidate product bugs; matching the wrong output would cement
  them.
- It does not touch the 65 already-skipped tests. They are out of scope and
  were skipped deliberately.

---

## Appendix — complete file index

Every failing file, its cluster, its provisional verdict and the phase that
owns it. `?` means the verdict is genuinely undecided and triage is part of
the work — do not assume **T**. Counts are `FAIL` entries from the run, which
include one file-level entry for suites that failed to collect; they total
slightly above the 289 reported failing tests for that reason.

Cluster **K** is the untriaged remainder: files whose single or double
failure did not match a proven signature. Phase 6 owns them, and the first
task for each is to assign it a real cluster — several will turn out to
belong to A, E or H once read.

| File | Fails | Cluster | Verdict | Phase |
| --- | ---: | --- | --- | ---: |
| `config/scripts/regenerate-xterm-patches.test.mjs` | 1 | C | T | 1 |
| `config/scripts/resolve-7za-path.test.mjs` | 1 | C | T | 1 |
| `config/scripts/trim-windows-icon-source.test.mjs` | 1 | C | T | 1 |
| `src/main/git/worktree-shared-directories.test.ts` | 25 | B | T | 2 |
| `config/scripts/mobile-pairing-qrcode-import-plugin.test.mjs` | 2 | D | T | 2 |
| `src/main/ipc/folder-repo-git-upgrade.test.ts` | 19 | A | C | 3 |
| `src/main/git/status-shared-symlinks.test.ts` | 9 | A | C | 3 |
| `src/main/ipc/worktree-symlinks.test.ts` | 9 | A | C | 3 |
| `src/main/source-control/hosted-review-creation-shared-symlinks.test.ts` | 7 | A | C | 3 |
| `src/main/agent-hooks/installer-utils.test.ts` | 3 | A | C | 3 |
| `src/relay/fs-handler.test.ts` | 3 | A | C | 3 |
| `src/main/local-downloaded-folder-promotion.test.ts` | 2 | A | C | 3 |
| `src/main/runtime/orca-runtime-files-terminal-artifact-grants.test.ts` | 2 | A | C | 3 |
| `src/main/runtime/orca-runtime-files-terminal-artifact-io.test.ts` | 2 | A | C | 3 |
| `src/main/claude-accounts/runtime-auth-service-materialization.test.ts` | 1 | A | C | 3 |
| `src/main/git/worktree-include-file.test.ts` | 1 | A | C | 3 |
| `src/main/local-builds/local-build-candidate.test.ts` | 1 | A | C | 3 |
| `src/main/skills/skill-share-preparation-service.test.ts` | 1 | A | C | 3 |
| `src/relay/subprocess.test.ts` | 1 | A | C | 3 |
| `src/main/runtime/exit-provenance-audit.test.ts` | 11 | F | T | 4 |
| `src/main/ephemeral-vm-runtime-service.test.ts` | 10 | E | T | 4 |
| `src/main/ssh/ssh-relay-upload-stage-commands.test.ts` | 10 | E | T | 4 |
| `src/main/ipc/ephemeral-vm.test.ts` | 8 | E | T | 4 |
| `src/main/ssh/ssh-remote-commands.test.ts` | 2 | E | T | 4 |
| `src/main/ipc/worktree-base-directory-watcher.test.ts` | 20 | G1 | T | 5 |
| `src/main/ipc/worktree-base-directory-event-filter.test.ts` | 6 | G1 | T | 5 |
| `src/main/codex/codex-session-resume-home.test.ts` | 9 | G2 | P? | 6 |
| `src/main/ai-vault/session-delete.test.ts` | 7 | G3 | P? | 6 |
| `src/main/ai-vault/session-delete-target.test.ts` | 5 | G3 | P? | 6 |
| `src/main/ai-vault/session-scanner-values.test.ts` | 5 | G2 | T? | 6 |
| `src/main/ssh/ssh-g-config-resolution.test.ts` | 4 | G2 | T? | 6 |
| `src/main/window/clipboard-file-copy.test.ts` | 4 | G2 | T? | 6 |
| `src/main/ai-vault/session-scanner-index-cache-wsl-stall.test.ts` | 3 | K | ? | 6 |
| `src/main/ai-vault/session-scanner.test.ts` | 3 | G2 | T? | 6 |
| `src/main/native-chat/transcript-read-cache.test.ts` | 3 | K | ? | 6 |
| `src/main/ai-vault/session-scanner-opencode-sources-wsl-stall.test.ts` | 2 | K | ? | 6 |
| `src/main/bitbucket/credential-store.test.ts` | 2 | K | ? | 6 |
| `src/main/codex/codex-session-resume-preparation.test.ts` | 2 | K | ? | 6 |
| `src/main/daemon/daemon-preflight-client-replacement.test.ts` | 2 | G2 | T? | 6 |
| `src/main/daemon/pty-subprocess-cwd-cancel-identity.test.ts` | 2 | K | ? | 6 |
| `src/main/daemon/pty-subprocess-env-inheritance.test.ts` | 2 | K | ? | 6 |
| `src/main/daemon/pty-subprocess-wsl-launch.test.ts` | 2 | K | ? | 6 |
| `src/main/git/repo-detection.test.ts` | 2 | G2 | T? | 6 |
| `src/main/git/worktree-deferred-removal-real-git.test.ts` | 2 | G2 | T? | 6 |
| `src/main/ipc/pty-codex-account-attribution.test.ts` | 2 | K | ? | 6 |
| `src/main/ipc/pty-login-shell-startup-commands.test.ts` | 2 | G2 | T? | 6 |
| `src/main/native-chat/transcript-watch-error.test.ts` | 2 | K | ? | 6 |
| `src/main/runtime/rpc/methods/ai-vault.test.ts` | 2 | G2 | T? | 6 |
| `src/main/skills/skill-provider-runtime-roots.test.ts` | 2 | G2 | T? | 6 |
| `src/relay/terminal-history-wsl.test.ts` | 2 | G2 | T? | 6 |
| `src/renderer/src/components/pull-request-page-host-boundary.test.ts` | 2 | G2 | T? | 6 |
| `src/shared/node-markdown-document-discovery.test.ts` | 2 | K | ? | 6 |
| `config/scripts/generate-bundled-skill-guides.test.mjs` | 1 | K | ? | 6 |
| `config/scripts/pr-workflow-parallelism.test.mjs` | 1 | K | ? | 6 |
| `config/scripts/verify-skills-cli-runtime.test.mjs` | 1 | G2 | T? | 6 |
| `src/main/agent-hooks/managed-hook-stdin-lifecycle.test.ts` | 1 | K | ? | 6 |
| `src/main/ai-vault/session-scanner-codex-dual-root.test.ts` | 1 | K | ? | 6 |
| `src/main/ai-vault/session-scanner-parse-wsl-stall.test.ts` | 1 | K | ? | 6 |
| `src/main/artifacts/artifact-create-intent-store.test.ts` | 1 | K | ? | 6 |
| `src/main/cli/linux-bare-orca-dispatcher.test.ts` | 1 | K | ? | 6 |
| `src/main/cli/windows-user-path-registry.test.ts` | 1 | K | ? | 6 |
| `src/main/codex-accounts/runtime-home-mirrored-status-home.test.ts` | 1 | K | ? | 6 |
| `src/main/codex-accounts/runtime-home-service-per-account-migration.test.ts` | 1 | G2 | T? | 6 |
| `src/main/daemon/daemon-pty-adapter-daemon-recovery.test.ts` | 1 | G2 | T? | 6 |
| `src/main/devin/hook-service.test.ts` | 1 | G2 | T? | 6 |
| `src/main/durable-file-write-syscall-proof.test.ts` | 1 | K | ? | 6 |
| `src/main/git/porcelain-v1-records.test.ts` | 1 | G2 | T? | 6 |
| `src/main/git/status-branch-line-total-exec-contract.test.ts` | 1 | G2 | T? | 6 |
| `src/main/ipc/local-network-connection-test.test.ts` | 1 | K | ? | 6 |
| `src/main/ipc/pty-daemon-spawn-wsl-runtime.test.ts` | 1 | G2 | T? | 6 |
| `src/main/ipc/pty-spawn-env-codex-resume-provenance.test.ts` | 1 | G2 | T? | 6 |
| `src/main/ipc/pty-wsl-cwd-validation.test.ts` | 1 | G2 | T? | 6 |
| `src/main/kimi/hook-service.test.ts` | 1 | G2 | T? | 6 |
| `src/main/providers/local-pty-shell-ready-wrapper-generation.test.ts` | 1 | G2 | T? | 6 |
| `src/main/pty/codex-shell-launch-preflight.test.ts` | 1 | G2 | T? | 6 |
| `src/main/rate-limits/service-inactive-account-previews.test.ts` | 1 | K | ? | 6 |
| `src/main/rate-limits/service-refresh-orchestration.test.ts` | 1 | K | ? | 6 |
| `src/main/runtime/agent-prompt-submission-runtime.test.ts` | 1 | K | ? | 6 |
| `src/main/runtime/agent-session-claim-identity.test.ts` | 1 | K | ? | 6 |
| `src/main/runtime/orca-runtime-files-terminal-link-host-translation.test.ts` | 1 | K | ? | 6 |
| `src/main/ssh/ssh-remote-node-resolution.test.ts` | 1 | K | ? | 6 |
| `src/main/ssh/system-ssh-forward-process.test.ts` | 1 | K | ? | 6 |
| `src/main/text-generation/commit-message-text-generation-model-discovery.test.ts` | 1 | K | ? | 6 |
| `src/main/updater.linux-root-package-install.test.ts` | 1 | K | ? | 6 |
| `src/relay/ai-vault-handler.test.ts` | 1 | K | ? | 6 |
| `src/relay/ai-vault-service-client.test.ts` | 1 | G2 | T? | 6 |
| `src/relay/rotating-log-writer.test.ts` | 1 | K | ? | 6 |
| `src/renderer/src/app-startup-routing.test.ts` | 1 | G2 | T? | 6 |
| `src/renderer/src/components/editor/monaco-content-sync.undo-history.test.ts` | 1 | G2 | T? | 6 |
| `src/renderer/src/components/right-sidebar/SourceControl.host-context-boundary.test.ts` | 1 | G2 | T? | 6 |
| `tests/e2e/helpers/nested-runtime-proxy-jump-fixture.unit.test.ts` | 1 | K | ? | 6 |
| `src/main/ssh/ssh-system-fallback.test.ts` | 7 | H | P? | 7 |
| `src/main/rate-limits/service-account-target-selection.test.ts` | 5 | H | P? | 7 |
| `src/main/cli/linux-terminal-orca-cli-shim.test.ts` | 2 | H | C | 7 |
| `src/main/rate-limits/codex-fetcher.test.ts` | 2 | H | P? | 7 |
| `src/main/ipc/filesystem-watcher-local-unsubscribe.test.ts` | 7 | I | ? | 8 |
| `src/main/ipc/native-chat.test.ts` | 3 | I | ? | 8 |
| `src/main/daemon/pty-subprocess.test.ts` | 2 | I | P? | 8 |
| `tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` | 1 | J | T | 9 |

**99 files accounted for — every file in the run.**

| Cluster | Files | Fails | Phase |
| --- | ---: | ---: | ---: |
| C | 3 | 3 | 1 |
| B | 1 | 25 | 2 |
| D | 1 | 2 | 2 |
| A | 14 | 61 | 3 |
| E | 4 | 30 | 4 |
| F | 1 | 11 | 4 |
| G1 | 2 | 26 | 5 |
| G2 | 29 | 57 | 6 |
| G3 | 2 | 12 | 6 |
| K | 34 | 47 | 6 |
| H | 4 | 16 | 7 |
| I | 3 | 12 | 8 |
| J | 1 | 1 | 9 |
| **total** | **99** | **303** | |

---

## Triage notes from the run

Findings recorded while working the phases, for whoever picks up the tail.

### `src/main/daemon/pty-subprocess-*` (4 files, 8 fails)

Two distinct causes behind one symptom.

**env-inheritance and the shell-features cases** exercise the POSIX branch of
`createPtySubprocess`. Production splits on `process.platform === 'win32'` at
`pty-subprocess.ts:711`, and everything these cases assert — `ORCA_SHELL_FEATURES`,
the `fish_history` and `HISTFILE` scrubbing — lives in the `else`. A
`shellOverride: '/bin/zsh'` does not reach it. POSIX-only by design, so a
platform skip is the honest gate.

**wsl-launch is different and more interesting.** It expects `wsl.exe` to be
called with no `-d`, but production consults the host and this machine has a
real distro, so it passes `-d podman-machine-default`. The test reads the
developer's actual WSL installation. That makes it pass or fail by accident of
the machine — it wants the distro resolution pinned, not the platform skipped.

### `src/main/codex/codex-legacy-session-resume.test.ts` (2 fails)

Two vault rows survive where one should. The dedup keys on a file identity
(`dev`/`ino`) that Windows does not report the way POSIX does. Candidate **P**:
if the identity is genuinely not comparable there, real users see duplicated
sessions. Needs its own look before anything is changed.

### Environment note

`pnpm install` cannot rebuild `windows-native-registry` on this machine
(node-gyp fails), which is why `windows-user-path-registry.test.ts` fails. That
predates this work and is a toolchain gap, not a code defect.

### `src/main/native-chat/transcript-watch-error.test.ts` (2 fails)

The fixture puts a directory at the transcript path so every tail read throws
EISDIR — a real, persistent read error rather than a missing file, chosen
deliberately to avoid the #8401 deferral. On Windows `readFileSync` does throw
EISDIR, but `openSync` on a directory **succeeds**, so the reader's open-and-read
path sees an empty transcript instead of an error and reports a clean empty
snapshot.

The behaviour under test — surface an error snapshot once, without spamming the
rotation retry — is platform-independent. Only the provocation is POSIX-shaped.
It needs a portable way to force a persistent read error before it can run here;
a capability gate would be honest but would lose the coverage on Windows, which
is where an unreadable transcript is at least as likely.

### `src/main/rate-limits/codex-fetcher.test.ts` — resolved, noted for the pattern

Worth recording because the shape recurs: a test asserting `child.kill()` is
asserting the POSIX half of a two-step termination. Windows has no SIGTERM, and
`terminateCodexProbeChild` knows it — stdin EOF is the graceful stop everywhere,
the signal is the backstop where signals are real. Assert that the child is gone,
not which mechanism got it there.

### `src/main/ipc/pty-daemon-spawn-wsl-runtime.test.ts` (1 fail) — candidate **P**

"drops a legacy shim PATH entry inherited from the host process on the daemon
path". The classifier is sound: `isLegacyTerminalShimPathEntry` folds both slash
styles before matching the suffix, so a backslashed entry is recognised. Feeding
the case a platform-shaped entry instead of the POSIX one it injects does **not**
make it pass, which points at the scrub rather than the spelling.

The case's own comment names the mechanism: the daemon path passes a sparse env,
so the PATH prepends re-read from `process.env` and the scrub has to outlive that
fallback. If it does not on Windows, a stale attribution shim survives into
terminals there — worth confirming against the real daemon path before deciding
whether the test or the scrub is wrong.

---

## Run 2 results — 2026-08-21

Second full sweep, same host, after phases 0–10:

```
Test Files  9 failed | 6022 passed | 66 skipped (6097)
     Tests  22 failed | 56054 passed | 918 skipped (57000)
  Duration  2610s
```

From 99 files / 289 tests to 9 files / 22 tests. What the nine were, and what
each turned out to be:

| File | Fails | Verdict | Outcome |
| --- | --- | --- | --- |
| `ssh-relay-upload-stage-commands.test.ts` | 9 | **P** (in the probe) | fixed |
| `pty-subprocess-foreground-scan-cadence.test.ts` | 4 | load flake | passes alone |
| `pet-from-image.test.ts` | 2 | **T** | already fixed after the run started |
| `ssh-remote-commands.test.ts` | 2 | **P** (in the probe) | fixed |
| `wsl-login-shell-command.test.ts` | 1 | load flake | passes alone |
| `updater.startup-scheduling.test.ts` | 1 | load flake | passes alone |
| `filesystem-list-files-git-fallback-real.test.ts` | 1 | **T** | fixed |
| `windows-user-path-registry.test.ts` | 1 | **C** | fixed (toolchain) |
| `resolve-7za-path.test.mjs` | 1 | network | passes alone |

### The POSIX shell probe was gated on the wrong thing

The eleven ssh failures were one bug in `src/shared/posix-shell.ts`, and it is
the exact mistake this plan's decision rule warns about — a capability gate that
is really an environment gate.

`findPosixShell()` tried `/bin/sh` and then `sh`. Git for Windows ships a POSIX
shell at `<root>/usr/bin/sh.exe` but only puts `<root>/cmd` on PATH, so:

- started from **Git Bash**, `/usr/bin` is on PATH → `sh` resolves → tests run;
- started from **cmd.exe or PowerShell**, it does not → the probe answers "no
  shell" → the ungated cases throw `No POSIX shell is available`.

Every earlier verification had been run from Git Bash, so the probe looked
correct. The detached sweep ran from cmd.exe and exposed it. CI would have hit
the same thing.

Fixed by asking `git --exec-path` where Git lives and climbing to `usr/bin/sh`,
so the answer is a property of the machine rather than of the parent process.
That alone was not enough: the shell's own utilities live in that same
directory, so a generated script found no `awk` and reached **System32's
`find.exe`** instead of the POSIX one — failing as `File not found - relay-*`
rather than loudly. `posixShellEnvironment()` prepends the directory onto the
spawn's PATH only, never onto `process.env`, so one suite cannot change what
`find` means for another.

**Rule to carry forward:** a capability probe must be verified from every shell
that can start the suite. Answering differently under cmd.exe and Git Bash is
the same defect class as answering differently under Windows and Linux.

### EBUSY on cleanup is not always a product bug

`filesystem-list-files-git-fallback-real.test.ts` failed its `afterEach` with
`EBUSY: rmdir`. The mechanism is real — a rejected scan cancels its sibling git
pass with `child.kill()`, which only *asks*, and until that process exits it
still holds the repo as its cwd, which Windows will not remove.

The first fix attempt made `listFilesWithGit` await its children's exit. That
was wrong, and the suite said so: there is a case named *"settles and detaches
git fallback scans that ignore timeout kills"*. Detaching is deliberate — Quick
Open must not hang behind a stuck git — and the wait also deadlocked under the
fake timers those cases use.

So the verdict is **T**, and the cleanup is what has to tolerate the overlap.
`removeHostTree` already exists for exactly this and carries the retries.

**Rule to carry forward:** before "fixing" a race in production, check whether a
neighbouring test already names the behaviour as intended.

### The toolchain gap was real

`windows-user-path-registry.test.ts` was not a test problem: `windows-native-registry`
had never been compiled, because no MSVC toolset was installed. Four install
attempts failed for four different reasons; the last three were diagnosable only
from `%TEMP%\dd_installer_*.log`:

1. the installer's own self-update gate (`Status changed to UpdateAvailable`);
2. `--wait` is not a valid argument to `setup.exe modify` (exit 87);
3. `Start-Process -ArgumentList` did not quote `C:\Program Files (x86)\...`, so
   the installer received `installPath: C:\Program` and reported *"An installed
   product matching the following parameters cannot be found"*.

Targeting the product by `--channelId` / `--productId` avoids the space
entirely. Worth remembering: `vswhere` reported `isComplete: False` throughout,
which was a symptom of the partial install rather than its cause.

### Remaining: four load-dependent flakes

`pty-subprocess-foreground-scan-cadence` (4), `wsl-login-shell-command` (1),
`updater.startup-scheduling` (1) and `resolve-7za-path` (1) all pass in
isolation and failed only in a saturated 6000-file sweep. They are deliberately
**not** in the baseline: recording them would make the baseline assert that
they fail, and a machine-specific timing artifact is not a contract.
`resolve-7za-path`'s case downloads a toolset with a cold cache, so it is
network-dependent as well as load-dependent.

---

## Final result — 2026-08-21

```
Test Files  6040 passed | 66 skipped (6106)
     Tests  56158 passed | 918 skipped (57082)
```

Zero failures, run from PowerShell. Baseline re-recorded as `{}` — from here any
failure is a regression, which is what makes the comparison a real gate.

Started at 99 files / 289 tests failing.

### The three that closed it, and what each really was

| Symptom | First diagnosis | Actual cause |
| --- | --- | --- |
| `updater.startup-scheduling`, `expected 2 got 3` | `vi.waitFor`'s 1s budget crossing the silent-settle deadline | a **ghost module instance**: `vi.resetModules()` discards the module but not its pending real-clock timers, and one fired inside a later test, arming a 24h check on *that* test's fake clock |
| `ssh-remote-commands` relay GC | slow I/O under load, needed a longer timeout | the test asserted an **enumeration order** the command never promises; NTFS returned the two entries reversed |
| `orca-runtime` 30s hang | resource starvation | a **1ms timer race** whose margin Node cannot actually resolve |

Every first diagnosis was wrong. Each one fit the evidence available at the time,
and fitting is not the same as being the cause.

### Why the static analysis kept failing

Two independent passes concluded the `orca-runtime` retire timer (49ms) must
always beat the waiter's rejection (50ms), because no `await` separates their
registration so both should share one cached loop time. Reading Node's
`_idleStart` directly refuted it:

```
setTimeout(f,50); burn(2ms); setTimeout(f,49)   →  _idleStart 18, 20  →  deadlines 68, 69
```

The deadline is `libuvNow(at insertion) + delay`, and `libuvNow` advances
mid-turn. The 0.1–1.7ms of synchronous work between the two calls consumes the
whole 1ms margin whenever it crosses a millisecond boundary. Both timers also
land in per-duration lists shared with unrelated timers — one of them
`SESSION_TABS_FLUSH_MS = 50`, armed by the same test.

**Rule:** a sub-millisecond timer margin is not a margin. Anchor the ordering to
a causal event.

### The instrument decides what you can see

`orca-runtime` passes **8/8** under 16-core CPU saturation and hangs **8/18**
under 5–6 concurrent Vitest workers. Burners deschedule the process in whole
quanta *between* loop turns; they cannot stretch a 0.2ms in-process synchronous
window past 1ms. Three sessions concluded "not load-related" from the wrong
instrument.

The right harness reproduced in ~5 minutes instead of a 45-minute sweep.

### Statistical discipline

Sample sizes of 4–5 produced two contradictory conclusions about the same
change. One proposed fix measured 4/8 → 4/8 — zero effect — and would have been
committed as a success on a smaller sample.

**Rule, enforced as a gate:** every variant is compared against a pristine
baseline measured with the same sample size in the same session, minimum 8 runs.
State the confidence: the runtime fix is 8/18 → 0/36 *and* has a deterministic
RED, which is what makes it conclusive rather than merely encouraging.
