import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { constants } from 'node:os'
import { spawnProcess } from '../../shared/child-process/run-process'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  SERVER_TARGETS,
  type ServerTarget
} from '../../shared/node-runtime-pin'

export class OrcadBundledRuntimeError extends Error {}
export const ORCAD_BUNDLED_LAUNCHER_ENV = 'ORCA_BUNDLED_LAUNCHER_CHANNEL'

function isServerTarget(value: string): value is ServerTarget {
  return SERVER_TARGETS.some((target) => target === value)
}

/**
 * The pinned Node a packaged slot in `directory` runs on, or null for an unpackaged entry.
 * Throws when the slot is packaged but its runtime reference is torn or foreign.
 */
export function resolveBundledOrcadRuntime(directory: string): string | null {
  const markerPath = join(directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  const targetPath = join(directory, ORCAD_SERVER_TARGET_FILENAME)
  const hasMarker = existsSync(markerPath)
  const hasTarget = existsSync(targetPath)
  if (!hasMarker && !hasTarget && !existsSync(join(directory, ORCAD_VERSION_FILENAME))) {
    return null
  }
  if (!hasTarget) {
    throw new OrcadBundledRuntimeError('The bundled Orca runtime target is missing')
  }
  if (!hasMarker) {
    throw new OrcadBundledRuntimeError('The bundled Orca runtime reference is missing')
  }
  const target = readFileSync(targetPath, 'utf8').trim()
  if (!isServerTarget(target)) {
    throw new OrcadBundledRuntimeError(`The bundled Orca runtime target is invalid: ${target}`)
  }
  const executableSha256 = readFileSync(markerPath, 'utf8').trim()
  // Why the pin and not only a digest shape: the marker becomes a path segment, and a slot
  // naming another runtime was not built by this code.
  if (executableSha256 !== NODE_RUNTIME_ASSETS[target].executableSha256) {
    throw new OrcadBundledRuntimeError(
      `The bundled Orca runtime reference does not name Node ${NODE_RUNTIME_PIN.version}`
    )
  }
  const runtime = join(directory, ...orcadNodeRuntimeRelativePath(target, executableSha256))
  if (!existsSync(runtime)) {
    throw new OrcadBundledRuntimeError('The bundled Orca runtime is missing')
  }
  return runtime
}

/** The running entry's real slot, resolved as the handoff does, so a symlinked orcad.js is checked. */
export function resolveBundledOrcadSlot(script = process.argv[1]): string {
  return resolveOrcadInstallRoot(script && realpathSync(script))
}

/** True only inside the pinned runtime a packaged slot names. */
export function isRunningAsBundledOrcadRuntime(directory: string): boolean {
  const runtime = resolveBundledOrcadRuntime(directory)
  return runtime !== null && realpathSync(process.execPath) === realpathSync(runtime)
}

/** Keep old Node service commands usable without letting a host Node open the profile. */
export function handoffToBundledOrcad(): boolean {
  const script = process.argv[1]
  if (!script) {
    return false
  }
  const entry = realpathSync(script)
  const runtime = resolveBundledOrcadRuntime(dirname(entry))
  if (!runtime) {
    return false
  }
  if (realpathSync(process.execPath) === realpathSync(runtime)) {
    if (process.versions.node !== NODE_RUNTIME_PIN.version) {
      throw new OrcadBundledRuntimeError(
        `The bundled Orca runtime must be Node ${NODE_RUNTIME_PIN.version}`
      )
    }
    return false
  }
  const child = spawnProcess({
    program: runtime,
    args: [entry, ...process.argv.slice(2)],
    env: { ...process.env, [ORCAD_BUNDLED_LAUNCHER_ENV]: '1' },
    // Windows' default child job kills the runtime before it can drain on launcher disconnect.
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  // Node resets nohup's disposition; headless runtimes stop through INT/TERM or owner loss.
  const ignoreHangup = (): void => {}
  if (process.platform !== 'win32') {
    process.on('SIGHUP', ignoreHangup)
  }
  const forwards = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const forward = (): void => {
      if (process.platform === 'win32') {
        // Detached Windows children have a separate console; kill() skips durable shutdown.
        if (child.connected) {
          child.disconnect()
        }
      } else {
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
