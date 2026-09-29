import { canUseBunPty, spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { spawnNativeDaemonPty } from '../daemon/pty-subprocess/native-pty-spawn'
import {
  spawnShellWithFallback,
  type ShellSpawnParams,
  type ShellSpawnResult
} from './local-pty-utils'

type LocalPtySpawn = (
  params: Omit<ShellSpawnParams, 'ptySpawn'> & { signal?: AbortSignal }
) => ShellSpawnResult | Promise<ShellSpawnResult>

/** Degraded daemon routing uses the same runtime as the packaged host. */
export async function loadLocalPtyRuntimeSpawn(): Promise<LocalPtySpawn> {
  if (!canUseBunPty()) {
    const pty = await import('node-pty')
    return (params) => spawnShellWithFallback({ ...params, ptySpawn: pty.spawn })
  }
  if (process.platform === 'win32') {
    return (params) =>
      spawnNativeDaemonPty({
        ...params,
        spawnCwd: params.cwd,
        windowsFallbackAttempts: params.windowsFallbackAttempts ?? []
      })
  }
  return (params) =>
    spawnShellWithFallback({
      ...params,
      ptySpawn(file, args = [], options = {}) {
        if (!Array.isArray(args)) {
          throw new Error('POSIX PTY arguments must be an array')
        }
        return spawnBunPty({
          file,
          args,
          cwd: options.cwd ?? params.cwd,
          env: params.env,
          cols: options.cols ?? params.cols,
          rows: options.rows ?? params.rows
        })
      }
    })
}
