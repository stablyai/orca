import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, resolve } from 'node:path'
import { isRunnableCommandAsync } from '../../../shared/shell/command-resolution/cli-fs-reads'
import {
  getExecutableNames,
  normalizePathEntry
} from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { agentModelCatalogScriptEntry } from './agent-model-catalog-script-entry'

// Config files are small; anything larger keeps the cheaper file-identity stamp.
export const MAX_HASHED_CONFIG_BYTES = 1024 * 1024

async function fileStamp(path: string, byContent = false): Promise<unknown> {
  try {
    const target = await realpath(path)
    const info = await stat(target)
    const identity = [target, info.ino, info.size, info.ctimeMs, info.mtimeMs]
    if (!byContent || !info.isFile() || info.size > MAX_HASHED_CONFIG_BYTES) {
      return identity
    }
    // A launch may atomically rewrite settings with identical bytes; a new inode or time with the
    // same bytes must not look like a change, or every probe would expire its own listing.
    try {
      const digest = createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
      return [target, 'sha256', digest]
    } catch {
      // A config that stats but cannot be read (e.g. Windows EBUSY) keeps the identity stamp.
      return identity
    }
  } catch {
    return [path, 'unknown']
  }
}

/** Observe install/config identity without running the CLI; config contents are only hashed. */
export async function agentModelCatalogInputStamp(input: {
  command: string
  prefixArgs?: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  configFiles?: readonly string[]
}): Promise<string> {
  const pathEnv = input.env.PATH ?? input.env.Path ?? ''
  let executable = resolve(input.cwd, input.command)
  if (!isAbsolute(input.command) && !/[\\/]/.test(input.command)) {
    search: for (const entry of pathEnv.split(delimiter)) {
      const directory = normalizePathEntry(process.platform, entry)
      for (const name of getExecutableNames(process.platform, input.command)) {
        const candidate = resolve(input.cwd, directory, name)
        if (await isRunnableCommandAsync(process.platform, candidate)) {
          executable = candidate
          break search
        }
      }
    }
  }
  const interpreter = basename(input.command)
    .replace(/\.exe$/i, '')
    .toLowerCase()
  const operand = agentModelCatalogScriptEntry(interpreter, input.prefixArgs ?? [])
  const script = operand ? resolve(input.cwd, operand) : undefined
  return JSON.stringify([
    await fileStamp(executable),
    script ? await fileStamp(script) : null,
    await Promise.all((input.configFiles ?? []).map((file) => fileStamp(file, true)))
  ])
}
