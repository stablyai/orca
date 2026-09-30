import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadBunRuntimeFilename
} from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

export class OrcadBundledRuntimeError extends Error {}

/** Reject the wrong runtime before application imports can touch a profile. */
export function assertBundledOrcadRuntime(): void {
  if (!process.versions.bun) {
    throw new OrcadBundledRuntimeError('Start orcad with its bundled bun-runtime, not Node')
  }
  const script = process.argv[1]
  if (!script) {
    return
  }
  const entry = realpathSync(script)
  const directory = dirname(entry)
  const runtime = join(directory, orcadBunRuntimeFilename(process.platform))
  const hasTarget = existsSync(join(directory, ORCAD_BUILD_TARGET_FILENAME))
  const hasRuntime = existsSync(runtime)
  if (!hasTarget && !hasRuntime && !existsSync(join(directory, ORCAD_VERSION_FILENAME))) {
    return
  }
  if (!hasTarget) {
    throw new OrcadBundledRuntimeError('The bundled Orca runtime target is missing')
  }
  if (!hasRuntime) {
    throw new OrcadBundledRuntimeError('The bundled Orca runtime is missing')
  }
  if (realpathSync(process.execPath) === realpathSync(runtime)) {
    if (process.versions.bun !== ORCAD_BUN_VERSION) {
      throw new OrcadBundledRuntimeError(
        `The bundled Orca runtime must be Bun ${ORCAD_BUN_VERSION}`
      )
    }
    return
  }
  throw new OrcadBundledRuntimeError(`Start orcad with its bundled runtime: ${runtime}`)
}
