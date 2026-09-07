import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'

/**
 * The preflight only prevents a loader crash if nothing in the bundle's import graph has
 * already required node-pty by the time it runs. esbuild wraps `local-pty-provider` in a
 * lazy initializer because `orcad-entry` reaches it through `await import('../ipc/pty')`,
 * and that laziness is load-bearing rather than incidental — a single top-level static
 * import anywhere in the graph would hoist `require("node-pty")` above every statement in
 * `main.ts`, including the preflight.
 *
 * Why this builds the bundle instead of skipping without one: no CI job builds orcad and
 * runs vitest. `smoke:orcad-terminal` builds it in the static-analysis job, which never
 * runs vitest; the `orcad_browser` job runs vitest but deliberately does not build orcad.
 * A `runIf(existsSync(...))` guard therefore skips in every shard, forever — the same way
 * an unset ORCA_BROWSER_EXECUTABLE kept the browser provider uncovered.
 *
 * Why not fail-when-CI instead: the wiring that would satisfy it lives in `.github/`, so
 * that turns a silent gap into a red build someone else has to fix. Building costs well
 * under a second (esbuild), works in every shard and on every machine, and needs no job
 * to cooperate. What it must never do is skip.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'out', 'orcad', 'orcad.js')
const BUILD_SCRIPT = join(REPO_ROOT, 'config', 'scripts', 'build-orcad.mjs')

/**
 * Why it throws rather than skipping when the build fails: a bundle that cannot be built
 * is a louder problem than the one this test checks, and swallowing it here is exactly
 * how the assertion would go missing.
 */
function ensureOrcadBundle(): void {
  if (existsSync(BUNDLE)) {
    return
  }
  const build = runProcessSync({
    program: process.execPath,
    args: [BUILD_SCRIPT],
    cwd: REPO_ROOT,
    timeoutMs: 300_000
  })
  if (!existsSync(BUNDLE)) {
    const output = `${build.stdout}${build.stderr}`.slice(0, 4000)
    throw new Error(
      `could not build ${BUNDLE} (exit ${build.code}); the load-order assertion cannot run:\n${output}`
    )
  }
}

describe('orcad bundle native load order', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not require node-pty in-process before the entry rejects its argv', () => {
    ensureOrcadBundle()
    const dir = mkdtempSync(join(tmpdir(), 'orcad-load-order-'))
    dirs.push(dir)
    const harness = join(dir, 'harness.cjs')
    writeFileSync(
      harness,
      [
        "const Module = require('module')",
        'const original = Module._load',
        'Module._load = function (request, ...rest) {',
        "  if (request === 'node-pty') { console.log('IN_PROCESS_NODE_PTY_REQUIRE') }",
        '  return original.call(this, request, ...rest)',
        '}',
        "process.argv.push('--orcad-load-order-check')",
        `require(${JSON.stringify(BUNDLE)})`
      ].join('\n')
    )

    const result = runProcessSync({
      program: process.execPath,
      args: [harness],
      timeoutMs: 120_000
    })
    const output = `${result.stdout}${result.stderr}`

    // Proof the graph fully loaded and reached argv parsing rather than dying early.
    expect(output).toContain('Unknown argument: --orcad-load-order-check')
    expect(output).not.toContain('IN_PROCESS_NODE_PTY_REQUIRE')
  }, 360_000)
})
