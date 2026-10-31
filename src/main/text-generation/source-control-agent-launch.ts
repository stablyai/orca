import { wslDistroForCommand } from '../../shared/wsl-paths'
import { spawnProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { resolveCliCommand } from '../codex-cli/command'
import { attachSourceControlInstallFallback } from './source-control-agent-install-fallback'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'
import { SOURCE_CONTROL_KILL_SITE } from './source-control-agent-termination'
import { wslAwareSpawn } from '../git/runner'
import { guestNativeSpawnEnv, oneShotGuestPathPolicy } from '../ipc/wsl-guest-windows-drive-path'
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
  const spawnEnv = input.env ?? process.env
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
        env: buildWslLauncherEnv(input.env),
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

// Supervisor owns the agent group so parent quit/death still stops generation.
function spawnSupervisedAgent(
  input: SourceControlAgentSpawnInput,
  spawnEnv: NodeJS.ProcessEnv
): SpawnedSourceControlAgentProcess {
  const installedFallback = !/[/\\]/.test(input.binary)
  const requestedCwd = (input.useCwdForNative ? input.cwd : undefined) ?? process.cwd()
  // Freeze the actual cwd without normalizing symlink/.. traversal or resolving it twice.
  const cwd = isAbsolute(requestedCwd) ? requestedCwd : `${process.cwd()}/${requestedCwd}`
  const policy = oneShotGuestPathPolicy(cwd)
  const childEnv = installedFallback
    ? policy.spawnEnv({ ...spawnEnv })
    : withCliRuntimeOnPath(input.binary, guestNativeSpawnEnv(spawnEnv))
  const home = childEnv.HOME ?? homedir()
  const context = {
    command: input.binary,
    homePath: isAbsolute(home) ? home : home ? `${cwd}/${home}` : cwd,
    platform: process.platform,
    runtimePathBase: policy.filterPath(childEnv.PATH ?? process.env.PATH ?? null),
    acceptPath: policy.acceptPath
  }
  const spec = createProviderSpawnSpec(
    {
      command: input.binary,
      args: input.args,
      cwd
    },
    // On a WSL-host orcad, a missing CLI must fail rather than run a Windows shim found via PATH.
    childEnv,
    process.platform,
    { lifetime: 'one-shot', ...(installedFallback ? { installedFallback: true } : {}) }
  )
  const child = spawnProcess({
    program: spec.program,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe', ...spec.groupReportStdio]
  })
  if (installedFallback) {
    attachSourceControlInstallFallback(child, context)
  }
  guardSupervisedProviderGroup(child, {
    site: SOURCE_CONTROL_KILL_SITE,
    supervised: spec.supervised
  })
  return Object.assign(child, { supervised: spec.supervised })
}
