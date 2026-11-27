import { writeFile } from 'node:fs/promises'

/** Names the file a fixture writes its result to; set by `runElectronFixture`. */
export const ELECTRON_FIXTURE_RESULT_ENV = 'ORCA_ELECTRON_FIXTURE_RESULT'
/** Set by `runElectronFixture` once it gave the fixture a display of its own (Xvfb on Linux). */
export const ELECTRON_FIXTURE_PRIVATE_DISPLAY_ENV = 'ORCA_ELECTRON_FIXTURE_PRIVATE_DISPLAY'

/**
 * Hands the fixture's result to the test through a file, not stdout: on Linux the fixture runs
 * under `xvfb-run`, whose Ubuntu script merges the command's stderr into stdout, so Chromium's
 * and the fixture's own stderr lines land after (or inside) a result printed there.
 */
export async function writeElectronFixtureResult(result: unknown): Promise<void> {
  const path = process.env[ELECTRON_FIXTURE_RESULT_ENV]
  if (!path) {
    throw new Error(`Missing ${ELECTRON_FIXTURE_RESULT_ENV}`)
  }
  await writeFile(path, JSON.stringify(result))
}
