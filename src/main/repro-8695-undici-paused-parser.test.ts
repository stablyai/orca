/**
 * Issue #8695 — bundled undici 7.28.0 asserts on paused parser when socket closes.
 *
 * Upstream: nodejs/undici#5360 / fix nodejs/undici#5474
 * Orca ships Electron 43 / Node 24.18.0 with undici 7.28.0 (still vulnerable).
 *
 * The crash is process-fatal (uncaught AssertionError), so we document version
 * pins here and keep the live crash script under docs/bug-reproductions/scripts/.
 *
 * Re-run unit proof:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/repro-8695-undici-paused-parser.test.ts
 *
 * Re-run live crash (expects non-zero exit):
 *   bash docs/bug-reproductions/scripts/repro-8695-undici-paused-parser.sh
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

describe('issue #8695 undici paused-parser assert', () => {
  it('worktree depends on vulnerable undici 7.28.0', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('undici/package.json') as { version: string }
    expect(pkg.version).toBe('7.28.0')
  })

  it('undici client-h1 still contains assert(!this.paused) in finish path', () => {
    // Why: upstream fix resumes/drains paused parser before finish; 7.28.0 still asserts.
    const clientH1 = readFileSync(require.resolve('undici/lib/dispatcher/client-h1.js'), 'utf8')
    expect(clientH1).toMatch(/assert\(!this\.paused\)/)
  })

  it('package.json pins Electron runtime that embeds Node 24 + undici 7.28.0', () => {
    const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
      engines?: { node?: string }
    }
    expect(rootPkg.devDependencies?.electron ?? rootPkg.engines?.node).toBeTruthy()
    expect(rootPkg.engines?.node).toMatch(/24/)
  })
})
