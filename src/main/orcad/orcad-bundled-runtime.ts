import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { constants } from 'node:os'
import { spawnProcess } from '../../shared/child-process/run-process'
import { ORCAD_BUILD_TARGET_FILENAME, orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

/** Keep old Node service commands usable without letting Node open the profile. */
export function handoffToBundledOrcad(): boolean {
  const script = process.argv[1]
  if (!script) {
    return false
  }
  const directory = dirname(resolve(script))
  const runtime = join(directory, orcadBunRuntimeFilename(process.platform))
  const hasTarget = existsSync(join(directory, ORCAD_BUILD_TARGET_FILENAME))
  const hasRuntime = existsSync(runtime)
  if (!hasTarget && !hasRuntime) {
    return false
  }
  if (!hasTarget) {
    throw new Error('The bundled Orca runtime target is missing')
  }
  if (!hasRuntime) {
    throw new Error('The bundled Orca runtime is missing')
  }
  if (realpathSync(process.execPath) === realpathSync(runtime)) {
    if (process.versions.bun !== ORCAD_BUN_VERSION) {
      throw new Error(`The bundled Orca runtime must be Bun ${ORCAD_BUN_VERSION}`)
    }
    return false
  }
  const child = spawnProcess({
    program: runtime,
    args: process.argv.slice(1),
    stdio: 'inherit'
  })
  const forwards = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const forward = (): void => {
      child.kill(signal)
    }
    process.on(signal, forward)
    return { signal, forward }
  })
  const cleanup = (): void => {
    for (const { signal, forward } of forwards) {
      process.off(signal, forward)
    }
  }
  child.once('error', (error) => {
    cleanup()
    console.error('orcad: could not start the bundled runtime:', error.message)
    process.exit(78)
  })
  child.once('exit', (code, signal) => {
    cleanup()
    if (signal && process.platform !== 'win32') {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1))
  })
  return true
}
