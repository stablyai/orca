import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the one idiom that keeps re-killing Windows tooling.
 *
 * Node >= 20 refuses to spawn a Windows batch shim without `shell: true` (the
 * CVE-2024-27980 mitigation), so `spawnSync('pnpm.cmd', …)` throws EINVAL
 * before the command runs at all. On Windows that reads as a broken toolchain
 * rather than a failing check, so the failure gets shrugged off — which is
 * exactly how `check:code-quality:changed` ran dead for months.
 *
 * `src/` has its own chokepoint (runProcess) and its own ratchet. These trees
 * are plain `.mjs` run by bare `node`, outside that module boundary, so they
 * need this narrower one: a batch-shim command literal may not appear in a new
 * script. The list only shrinks. Resolve the real executable instead —
 * `oxlint-cli-invocation.mjs` and `windows-process-tree-gyp-rebuild.mjs` show
 * the shape.
 *
 * Deliberately a text match on any `.cmd`/`.bat` literal, not on a list of
 * runner names: these trees already spawn vitest, playwright, electron-builder
 * and tsc, and the next offender is as likely to be one of those as it is to be
 * pnpm. A literal is all a copy-paste carries.
 *
 * Two shapes this does not catch, both accepted. A shim assembled in a template
 * literal, and a drive-lettered path — 'C:\tools\pnpm.cmd' — since a colon is
 * not in the class. Real code builds those with path.join, whose 'pnpm.cmd'
 * argument is caught. Also note codeText only drops lines that BEGIN with a
 * comment marker, so a trailing `// 'pnpm.cmd'` false-positives; that fails
 * closed. All of which is the ceiling of a text ratchet, and the reason `src/`
 * gets a real chokepoint instead.
 */
const WINDOWS_SHIM_LITERAL = /['"][\w./\\-]*\.(?:cmd|bat)['"]/i

const SCANNED_ROOTS = ['config/scripts', 'tests/tools']

/** Scripts that still name a batch shim, held as data so it reads as the list it is. */
const WINDOWS_SHIM_SPAWN_ALLOWLIST = [
  // Owns the pnpm invocation decision for every other script.
  'config/scripts/pnpm-cli-invocation.mjs',
  'config/scripts/pnpm-cli-invocation.test.mjs',
  // Write or assert on shim files rather than spawning one.
  'config/scripts/dev-cli-terminal-wrapper.mjs',
  'config/scripts/dev-cli-terminal-wrapper.test.mjs',
  'config/scripts/electron-builder-config.test.mjs',
  'config/scripts/ensure-native-runtime.test.mjs',
  'config/scripts/live-remote-freeze-rpc.mjs',
  'config/scripts/remote-agent-session-authority-repro.mjs',
  // Platform-local build paths; the win32 branch is dead code on both.
  'config/scripts/build-mac-local.mjs',
  'config/scripts/build-linux-local.mjs',
  'config/scripts/build-linux-local.test.mjs',
  // Benchmarks, repros and e2e drivers — developer-invoked or Linux-only in CI.
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/run-ai-vault-typing-bench.mjs',
  'config/scripts/run-ephemeral-vm-runtime-store-rollback-repro.mjs',
  'config/scripts/run-local-ssh-browser-routing-e2e.mjs',
  'config/scripts/run-multi-client-navigation-e2e.mjs',
  'config/scripts/run-multi-workspace-typing-bench.mjs',
  'config/scripts/run-nested-runtime-ssh-e2e.mjs',
  'config/scripts/run-ssh-client-hosted-browser-drop-reconnect-e2e.mjs',
  'config/scripts/run-ssh-codex-artifacts-repro-e2e.mjs',
  'config/scripts/run-ssh-docker-e2e.mjs',
  'config/scripts/run-ssh-docker-perf-e2e.mjs',
  'config/scripts/run-ssh-docker-terminal-parking-e2e.mjs',
  'config/scripts/run-ssh-docker-watcher-isolation-e2e.mjs',
  'config/scripts/run-ssh-staged-upload-reliability.mjs',
  'config/scripts/run-terminal-ibus-hangul-e2e.mjs',
  'config/scripts/run-terminal-scale-perf-e2e.mjs',
  // Routes its shim through an explicit `cmd.exe /d /s /c`, which is the correct form.
  'config/scripts/verify-skill-update-roundtrip.mjs',
  'tests/tools/benchmarks/startup-time-bench.mjs',
  'tests/tools/benchmarks/worktree-deletion-dev-bench.mjs',
  'tests/tools/repro-terminal-send-submit.mjs'
]

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents) {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

// Why recursive: a future config/scripts/<subdir>/ would otherwise escape silently.
function collectScripts(directory, repoRoot, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collectScripts(full, repoRoot, found)
      }
      continue
    }
    if (/\.[cm]?js$/.test(entry.name)) {
      found.push(path.relative(repoRoot, full).split(path.sep).join('/'))
    }
  }
  return found
}

describe('windows batch shim spawn boundary', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..')
  const scripts = SCANNED_ROOTS.flatMap((root) =>
    collectScripts(path.join(repoRoot, root), repoRoot)
  )
  const offenders = scripts.filter((relativePath) =>
    WINDOWS_SHIM_LITERAL.test(codeText(readFileSync(path.join(repoRoot, relativePath), 'utf8')))
  )

  it('scans a plausible number of scripts', () => {
    // A broken root or extension filter would make the guard silently vacuous.
    expect(scripts.length).toBeGreaterThan(100)
  })

  it('has no unlisted script naming a Windows batch shim', () => {
    const unlisted = offenders.filter((name) => !WINDOWS_SHIM_SPAWN_ALLOWLIST.includes(name))
    expect(
      unlisted,
      'Node cannot spawn a Windows batch shim without a shell. Resolve the real executable — see oxlint-cli-invocation.mjs.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = WINDOWS_SHIM_SPAWN_ALLOWLIST.filter((name) => !offenders.includes(name))
    expect(stale, 'Script no longer names a batch shim — delete the line.').toEqual([])
  })
})
