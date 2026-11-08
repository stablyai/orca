import { wslDistroForCommand } from '../../shared/wsl-paths'
import { spawnProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCliCommand } from '../codex-cli/command'
import { wslAwareSpawn } from '../git/runner'
import { AGENT_PANE_HOOK_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import { spawnSupervisedAgent } from './source-control-supervised-agent-spawn'
import type {
  SourceControlAgentSpawnInput,
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

const PANE_HOOK_ENV_KEYS = new Set<string>(AGENT_PANE_HOOK_ENV_KEYS)

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
  const wslDistro = input.preparation
    ? wslDistroForCommand(input.cwd, input.wslDistro)
    : input.wslDistro
  // Background agents cannot report hooks against the terminal that launched Orca.
  const spawnEnv = { ...(input.env ?? process.env) }
  for (const key of Object.keys(spawnEnv)) {
    if (PANE_HOOK_ENV_KEYS.has(process.platform === 'win32' ? key.toUpperCase() : key)) {
      delete spawnEnv[key]
    }
  }
  if (process.platform === 'win32' && wslDistro) {
    // Apply command assignments after guest login-shell setup, never to the Windows launcher.
    const assignments = Object.entries(input.commandEnv ?? {}).map(
      ([key, value]) => `${key}=${value}`
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WSL spawn pipes both output streams and supplies the configured stdin stream.
    return wslAwareSpawn(
      assignments.length ? '/usr/bin/env' : input.binary,
      assignments.length ? [...assignments, input.binary, ...input.args] : input.args,
      {
        cwd: input.cwd,
        env: buildWslLauncherEnv(spawnEnv),
        stdio: [input.stdinMode, 'pipe', 'pipe'],
        windowsHide: true,
        wslDistro,
        useWslLoginShell: true,
        ...(input.preparation ? { preparation: input.preparation } : {})
      }
    ) as SpawnedSourceControlAgentProcess
  }
  const child =
    process.platform === 'win32'
      ? spawnWindowsAgent(input, spawnEnv)
      : spawnSupervisedAgent(input, spawnEnv)
  if (input.stdinMode === 'ignore') {
    child.stdin?.on?.('error', () => {})
    child.stdin?.end()
  }
  return child
}

function spawnWindowsAgent(
  input: SourceControlAgentSpawnInput,
  spawnEnv: NodeJS.ProcessEnv
): SpawnedSourceControlAgentProcess {
  const resolvedBinary = resolveCliCommand(input.binary, {
    pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null
  })
  // #28768: let process-host resolve npm shims as node + script so multiline argv survives.
  return spawnProcess({
    program: resolvedBinary,
    args: input.args,
    env: withCliRuntimeOnPath(resolvedBinary, spawnEnv),
    ...(input.useCwdForNative ? { cwd: input.cwd } : {})
  })
}
