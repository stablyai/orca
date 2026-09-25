import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { constants } from 'node:os'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadBunRuntimeFilename
} from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

export class OrcadBundledRuntimeError extends Error {}
export const ORCAD_BUNDLED_LAUNCHER_ENV = 'ORCA_BUNDLED_LAUNCHER_CHANNEL'

/** Keep old Node service commands usable without letting Node open the profile. */
export function handoffToBundledOrcad(): boolean {
  const script = process.argv[1]
  if (!script) {
    return false
  }
  const entry = realpathSync(script)
  const directory = dirname(entry)
  const runtime = join(directory, orcadBunRuntimeFilename(process.platform))
  const hasTarget = existsSync(join(directory, ORCAD_BUILD_TARGET_FILENAME))
  const hasRuntime = existsSync(runtime)
  if (!hasTarget && !hasRuntime && !existsSync(join(directory, ORCAD_VERSION_FILENAME))) {
    return false
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
    return false
  }
  const child = spawnProcess({
    program: runtime,
    args: [entry, ...process.argv.slice(2)],
    env: { ...process.env, [ORCAD_BUNDLED_LAUNCHER_ENV]: '1' },
    detached: process.platform !== 'win32',
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  // Node resets nohup's disposition; headless runtimes stop through INT/TERM or owner loss.
  const ignoreHangup = (): void => {}
  if (process.platform !== 'win32') {
    process.on('SIGHUP', ignoreHangup)
  }
  const forwards = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const forward = (): void => {
      // Windows consoles already signal the child; kill() would abort its durable shutdown.
      if (process.platform !== 'win32') {
        child.kill(signal)
      }
    }
    process.on(signal, forward)
    return { signal, forward }
  })
  const cleanup = (): void => {
    process.off('SIGHUP', ignoreHangup)
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
