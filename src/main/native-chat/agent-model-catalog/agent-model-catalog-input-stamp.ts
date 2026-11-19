import { createHash } from 'node:crypto'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, delimiter, isAbsolute, resolve } from 'node:path'
import { getExecutableNames } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { agentModelCatalogScriptEntry } from './agent-model-catalog-script-entry'

async function fileStamp(path: string): Promise<unknown> {
  try {
    const target = await realpath(path)
    const info = await stat(target)
    return [target, info.ino, info.size, info.ctimeMs, info.mtimeMs]
  } catch {
    return [path, 'unknown']
  }
}

/** CLIs rewrite their own configs byte-identically through a temp file and rename; identity is content, not inode churn (#44692). */
async function configFileStamp(path: string): Promise<unknown> {
  try {
    return [
      path,
      'content',
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    ]
  } catch {
    return [path, 'unknown']
  }
}

/** Observe install identity and config content without running the CLI or retaining config bytes. */
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
    search: for (const directory of pathEnv.split(delimiter)) {
      for (const name of getExecutableNames(process.platform, input.command)) {
        const candidate = resolve(input.cwd, directory, name)
        try {
          await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
          executable = candidate
          break search
        } catch {}
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
    await Promise.all((input.configFiles ?? []).map(configFileStamp))
  ])
}
