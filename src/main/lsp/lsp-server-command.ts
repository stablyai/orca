import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { LANGUAGE_SERVER_CATALOG } from '../../shared/language-server-catalog'
import type {
  LanguageServerId,
  RepoLanguageServerSettings
} from '../../shared/language-server-types'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { resolveCommandOnLocalPath, type ResolveCommandOptions } from '../ipc/command-path-resolver'

export type ResolvedLspCommand = { program: string; args: string[]; env: NodeJS.ProcessEnv }
export type ResolvedLspServer = { command: ResolvedLspCommand; initializationOptions: unknown }

export type LspServerCommandDeps = {
  platform: NodeJS.Platform
  loginShellEnv: () => Promise<NodeJS.ProcessEnv>
  resolveOnPath: (command: string, options: ResolveCommandOptions) => Promise<string | null>
  fileExists: (path: string) => Promise<boolean>
  bundledTypescriptPaths: () => { cliPath: string; tsserverPath: string }
}

const requireFromMain = createRequire(__filename)

function unpackedPath(path: string): string {
  return path.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
}

function installedPackageDir(name: string): string {
  // Why: exports maps can hide package.json; walk the resolver's search dirs instead.
  for (const base of requireFromMain.resolve.paths(name) ?? []) {
    const dir = join(base, name)
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }
  }
  throw new Error(`${name} is not installed`)
}

const defaultDeps: LspServerCommandDeps = {
  platform: process.platform,
  loginShellEnv: () => resolveLoginShellEnvironment(),
  resolveOnPath: resolveCommandOnLocalPath,
  fileExists: (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  bundledTypescriptPaths: () => ({
    cliPath: unpackedPath(
      join(installedPackageDir('typescript-language-server'), 'lib', 'cli.mjs')
    ),
    tsserverPath: unpackedPath(join(installedPackageDir('typescript-6'), 'lib', 'tsserver.js'))
  })
}

export async function resolveLspServerCommand(
  serverId: LanguageServerId,
  rootPath: string,
  settings: RepoLanguageServerSettings | undefined,
  deps: LspServerCommandDeps = defaultDeps
): Promise<ResolvedLspServer | null> {
  const entry = LANGUAGE_SERVER_CATALOG[serverId]
  if (entry.kind === 'bundled') {
    const { cliPath, tsserverPath } = deps.bundledTypescriptPaths()
    const projectTsserver = join(rootPath, 'node_modules', 'typescript', 'lib', 'tsserver.js')
    // Why: TypeScript 7 ships no tsserver.js, so native-TS projects fall back to the bundled TS 6.
    const path = (await deps.fileExists(projectTsserver)) ? projectTsserver : tsserverPath
    return {
      command: {
        program: process.execPath,
        args: [cliPath, '--stdio'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      },
      initializationOptions: { tsserver: { path } }
    }
  }
  const [name, ...args] = settings?.command?.[serverId] ?? entry.defaultCommand
  const env = await deps.loginShellEnv()
  // Why: version-manager shims pick the project's Ruby from cwd, and win32 needs an absolute program.
  const program = await deps.resolveOnPath(name, { env, cwd: rootPath, platform: deps.platform })
  if (!program) {
    return null
  }
  return { command: { program, args, env }, initializationOptions: entry.initializationOptions }
}
