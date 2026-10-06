import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the app-start line that lets Orca ask Codex for its hook hashes, and
 * warms the answer once the shell PATH is hydrated. Without it every managed
 * Codex launch writes no Orca hook (nothing may ask), and without the PATH
 * wait a packaged app looks for codex on launchd's PATH and finds none.
 *
 * Source-level because the call sits inside the ready-phase composition, which
 * has no runtime seam; the lookup's own ordering is tested in codex-hook-hash-lookup.test.ts.
 */
describe('Codex hook hash warm-up startup wiring', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-ready-runtime.ts'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const READY_ENTRY = 'export async function initializeReadyRuntimeServices('
  const entryBody = source.slice(source.indexOf(READY_ENTRY)).split('\nexport ')[0]!

  it('starts the lookup unconditionally in app readiness, after the shell PATH is hydrated', () => {
    expect(source).toContain(
      "import { startCodexHookHashLookup } from '../codex/codex-hook-hash-lookup'"
    )
    expect(entryBody.split('startCodexHookHashLookup(').length - 1).toBe(1)
    // Why pin the indent: inside an added `if (...)` the call would stop running on most starts.
    expect(entryBody).toContain('\n  startCodexHookHashLookup({')
    expect(entryBody).toContain(
      'pathReady: app.isPackaged ? hydrateAgentCliShellPath() : Promise.resolve()'
    )
  })
})
