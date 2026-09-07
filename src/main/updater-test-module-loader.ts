import { beforeAll, TestRunner } from 'vitest'
import type * as UpdaterModule from './updater'

/**
 * Pays `updater.ts`'s transform cost once per file, against `hookTimeout` instead of `testTimeout`.
 *
 * Why: the module is ~2.4k lines and pulls in a wide graph, so a worker's first import of it costs
 * ~1.4s idle but 45s+ on an oversubscribed machine — past the 30s `testTimeout`. `vi.resetModules()`
 * re-evaluates the module without re-transforming it, so only a file's *first* import is exposed;
 * warming it in a hook moves that one slow import onto the 60s hook budget and leaves every in-test
 * import at re-evaluation cost (~25ms idle).
 */
export function warmUpdaterModule(): void {
  beforeAll(async () => {
    await import('./updater')
  })
}

/**
 * Imports `./updater`, refusing to hand the module to a test that has already ended.
 *
 * Why: vitest cannot cancel a timed-out test body. When the import outran `testTimeout` the
 * continuation went on to call `setupAutoUpdater` during the *next* test, failing it with
 * "expected 1 times, but got 2 times" — the exact signature of the abandoned-instance timer flake
 * fixed in #17649/#17663, so the timeout read as that regression returning. Throwing here strands the
 * continuation and leaves the timeout as the only reported failure.
 */
export async function loadUpdaterModule(): Promise<typeof UpdaterModule> {
  const owner = TestRunner.getCurrentTest()
  const module = await import('./updater')
  if (owner !== undefined && TestRunner.getCurrentTest() !== owner) {
    // Why: vitest has already settled the timed-out test's promise, so this throw is swallowed —
    // warn separately or the reason the continuation was stranded reaches nobody.
    process.emitWarning(
      `updater import requested by "${owner.name}" resolved after that test ended. The test timed ` +
        `out mid-import; fix that timeout, not the assertions.`
    )
    throw new Error(`updater import for "${owner.name}" resolved after that test ended`)
  }
  return module
}
