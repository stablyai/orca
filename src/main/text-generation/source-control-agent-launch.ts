import { spawnProcess } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCliCommand } from '../codex-cli/command'
import { wslAwareSpawn } from '../git/runner'
import { getSpawnArgsForWindows } from '../win32-utils'
import type {
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

const WSL_LAUNCHER_ENV_KEYS = [
  'ComSpec',
  'COMSPEC',
  'Path',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'WINDIR'
] as const

function buildWslLauncherEnv(explicitEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of WSL_LAUNCHER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(explicitEnv ?? {})) {
    if (value !== undefined && value !== process.env[key]) {
      env[key] = value
    }
  }
  return env
}

export const spawnSourceControlAgent: SpawnSourceControlAgent = (input) => {
  const spawnEnv = input.env ?? process.env
  if (process.platform === 'win32' && input.wslDistro) {
    // Apply assignments in the guest after its login shell, not to the Windows launcher.
    const assignments = Object.entries(input.commandEnv ?? {}).map(
      ([key, value]) => `${key}=${value}`
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WSL spawn pipes both output streams and supplies the configured stdin stream.
    return wslAwareSpawn(
      assignments.length ? '/usr/bin/env' : input.binary,
      assignments.length ? [...assignments, input.binary, ...input.args] : input.args,
      {
        cwd: input.cwd,
        env: buildWslLauncherEnv(input.env),
        stdio: [input.stdinMode, 'pipe', 'pipe'],
        windowsHide: true,
        wslDistro: input.wslDistro,
        useWslLoginShell: true
      }
    ) as SpawnedSourceControlAgentProcess
  }
  const resolvedBinary =
    process.platform === 'win32'
      ? resolveCliCommand(input.binary, { pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null })
      : input.binary
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedBinary, input.args)
  const child = spawnProcess({
    program: spawnCmd,
    args: spawnArgs,
    env: withCliRuntimeOnPath(resolvedBinary, spawnEnv),
    ...(input.useCwdForNative ? { cwd: input.cwd } : {})
  })
  if (input.stdinMode === 'ignore') {
    child.stdin?.on?.('error', () => {})
    child.stdin?.end()
  }
  return child
}
