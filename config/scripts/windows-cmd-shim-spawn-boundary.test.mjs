import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasNodeModulesBinSpawn } from './windows-bin-spawn-predicate.mjs'

/**
 * Bare JS scripts cannot use the TS runProcess chokepoint; resolve package bins
 * under process.execPath instead (see oxc-cli-invocation.mjs). The list only shrinks.
 * The literal check catches quoted .cmd/.bat paths, excluding drive letters and
 * templates; comment-only lines are dropped, but trailing comments fail closed.
 * The AST check catches spawn/spawnSync/execFile/execFileSync first arguments
 * containing node_modules/.bin: literals, templates, concatenation, join/resolve,
 * local variable initializers and ternaries. It does not follow imports, function
 * returns, assignments, destructuring, aliased spawn names or computed members.
 * Names are matched without scope/import resolution; shadowed names and non-path
 * join/resolve calls can fail closed. Paths are joined textually, without reducing
 * dot segments. Neither check proves a Windows branch or an actual unsafe spawn.
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
  'config/scripts/pty-transcript-secret-scan.test.mjs',
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
  const offenders = scripts.filter((relativePath) => {
    const contents = readFileSync(path.join(repoRoot, relativePath), 'utf8')
    return WINDOWS_SHIM_LITERAL.test(codeText(contents)) || hasNodeModulesBinSpawn(contents)
  })

  it('scans a plausible number of scripts', () => {
    // A broken root or extension filter would make the guard silently vacuous.
    expect(scripts.length).toBeGreaterThan(100)
  })

  it('has no unlisted script naming a Windows batch shim or spawning a package bin shim', () => {
    const unlisted = offenders.filter((name) => !WINDOWS_SHIM_SPAWN_ALLOWLIST.includes(name))
    expect(
      unlisted,
      'Node cannot spawn a Windows batch shim without a shell. Resolve the real executable — see oxc-cli-invocation.mjs.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = WINDOWS_SHIM_SPAWN_ALLOWLIST.filter((name) => !offenders.includes(name))
    expect(stale, 'Script no longer matches either shim predicate — delete the line.').toEqual([])
  })
})
