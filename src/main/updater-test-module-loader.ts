import { beforeAll, TestRunner } from 'vitest'
import type * as UpdaterModule from './updater'

// Warm the module graph under hookTimeout so initial transforms do not consume testTimeout.
export function warmUpdaterModule(): void {
  beforeAll(async () => {
    await import('./updater')
  })
}

// Vitest cannot cancel timed-out imports; reject late continuations before they touch the next test.
export async function loadUpdaterModule(): Promise<typeof UpdaterModule> {
  const owner = TestRunner.getCurrentTest()
  const module = await import('./updater')
  if (owner !== undefined && TestRunner.getCurrentTest() !== owner) {
    // The timed-out test's rejection is already settled, so report the late import separately.
    process.emitWarning(
      `updater import requested by "${owner.name}" resolved after that test ended. The test timed ` +
        `out mid-import; fix that timeout, not the assertions.`
    )
    throw new Error(`updater import for "${owner.name}" resolved after that test ended`)
  }
  return module
}
