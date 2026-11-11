import { AsyncLocalStorage } from 'node:async_hooks'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  isCommandOnLocalPath,
  resolveSelectedLocalCommand
} from '../../ipc/command-path/command-path-resolver'
import type { ResolvedCommand } from './wsl-command-resolution'

const currentBatch = new AsyncLocalStorage<GhExecutableAbsenceBatch>()
const batches = new Set<GhExecutableAbsenceBatch>()

function searchScope(command: ResolvedCommand, env: NodeJS.ProcessEnv): string | null {
  if (command.wsl || command.binary !== 'gh' || !command.cwd) {
    return null
  }
  const pathKey = Object.keys(env).find((key) =>
    process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  )
  const searchPath = pathKey ? env[pathKey] : undefined
  if (!searchPath || searchPath.split(path.delimiter).some((entry) => !path.isAbsolute(entry))) {
    return null
  }
  const extensions = Object.entries(env).find(([key]) => key.toLowerCase() === 'pathext')?.[1]
  return JSON.stringify([process.platform, command.binary, searchPath, extensions])
}

/** A finite recovery batch shares only proved native executable absence, never API failures. */
export class GhExecutableAbsenceBatch {
  private readonly missing = new Map<string, unknown>()

  constructor() {
    batches.add(this)
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return currentBatch.run(this, operation)
  }

  close(): void {
    batches.delete(this)
    this.missing.clear()
  }

  static assertAvailable(command: ResolvedCommand, env: NodeJS.ProcessEnv): Promise<void> | null {
    const batch = currentBatch.getStore()
    if (!batch?.missing.size) {
      return null
    }
    const scope = searchScope(command, env)
    if (!scope || !batch.missing.has(scope)) {
      return null
    }
    if (resolveSelectedLocalCommand('gh', { env, cwd: command.cwd }) !== 'gh') {
      batch.missing.delete(scope)
      return null
    }
    if (process.platform === 'win32') {
      // Windows searches each checkout before PATH; a peer may have its own executable.
      const localEnv = Object.fromEntries(
        Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')
      )
      return isCommandOnLocalPath('gh', {
        env: { ...localEnv, PATH: '' },
        cwd: command.cwd
      }).then((found) => {
        if (!found) {
          throw batch.missing.get(scope)
        }
      })
    }
    throw batch.missing.get(scope)
  }

  static async recordMissing(
    command: ResolvedCommand,
    env: NodeJS.ProcessEnv,
    error: unknown
  ): Promise<void> {
    const batch = currentBatch.getStore()
    const scope = batch && searchScope(command, env)
    if (
      !batch ||
      !scope ||
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT' ||
      batch.missing.get(scope) === error
    ) {
      return
    }
    try {
      if (
        command.cwd &&
        (await stat(command.cwd)).isDirectory() &&
        resolveSelectedLocalCommand('gh', { env, cwd: command.cwd }) === 'gh' &&
        !(await isCommandOnLocalPath('gh', { env, cwd: command.cwd })) &&
        batches.has(batch)
      ) {
        batch.missing.set(scope, error)
      }
    } catch {
      // A missing cwd or unreadable search environment proves nothing about peer checkouts.
    }
  }

  static recordSuccess(command: ResolvedCommand, env: NodeJS.ProcessEnv): void {
    const scope = batches.size && searchScope(command, env)
    if (scope) {
      for (const batch of batches) {
        batch.missing.delete(scope)
      }
    }
  }
}
