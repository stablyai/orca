import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { getSpawnArgsForWindows } from '../../shared/windows-batch-spawn'
import { resolveWindowsCommand } from '../win32-utils'
import type { LspServerDescriptor } from './lsp-server-catalog'

export type SpawnLspServer = (
  descriptor: LspServerDescriptor,
  rootPath: string
) => ChildProcessWithoutNullStreams

export const spawnLspServer: SpawnLspServer = (descriptor, rootPath) => {
  // Why: npm-installed servers are .cmd shims on Windows; resolve the PATH entry
  // and route batch scripts through cmd.exe explicitly (spawn+shell hits DEP0190).
  const command = resolveWindowsCommand(descriptor.command)
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [...descriptor.args])
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: rootPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Why: hydrateShellPath already merged the login-shell PATH into process.env.
    env: process.env
  })
  // Why: nothing reads stderr; an undrained pipe blocks the server once the OS
  // buffer fills (rust-analyzer and gopls log there routinely).
  child.stderr.resume()
  return child
}
