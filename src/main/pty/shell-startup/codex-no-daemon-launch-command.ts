import { isAbsolute, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  codexSkipsIsolationProbe,
  readCodexDirectLaunch
} from '../../../shared/agent-launch/startup/codex-startup-image-command'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'

// A hung capability probe must not block pane creation indefinitely.
const HELP_PROBE_TIMEOUT_MS = 5_000

export type LocalCodexLaunch = {
  command: string | undefined
  /** False for SSH and WSL spawns: their shell's codex function probes on that host. */
  executesOnThisHost: boolean
  /** Overrides inherited process env. */
  env: Record<string, string | undefined> | undefined
  /** Removed after env overrides are merged. */
  envToDelete?: readonly string[]
  cwd: string | undefined
}

/** Probe the same executable, directory and environment that will reach the terminal. */
export function planCodexNoDaemonLaunch(
  launch: LocalCodexLaunch,
  shell: AgentStartupShell,
  invocation = launch.command ? readCodexDirectLaunch(launch.command, shell) : null
): Promise<boolean> | null {
  if (
    !invocation?.args ||
    !launch.executesOnThisHost ||
    codexSkipsIsolationProbe(invocation.args)
  ) {
    return null
  }
  const env = { ...process.env, ...launch.env }
  const scoped = invocation.launch.env
  const envKey = (key: string): string => (process.platform === 'win32' ? key.toUpperCase() : key)
  const replaced = new Set([...(launch.envToDelete ?? []), ...scoped.keys()].map(envKey))
  for (const key of Object.keys(env)) {
    if (replaced.has(envKey(key))) {
      delete env[key]
    }
  }
  for (const [key, value] of scoped) {
    if (value !== undefined) {
      env[envKey(key)] = value
    }
  }
  if (env.ORCA_CODEX_ISOLATE === '0') {
    return null
  }
  const { executable, cwd } = invocation.launch
  return supportsNoDaemon(
    executable,
    env,
    cwd ? resolve(launch.cwd ?? process.cwd(), cwd) : launch.cwd
  )
}

// Reprobe after possible upgrades; older Codex versions reject the flag.
async function supportsNoDaemon(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<boolean> {
  const program = isAbsolute(executable)
    ? executable
    : /[\\/]/.test(executable)
      ? resolve(cwd ?? process.cwd(), executable)
      : await resolveCommandOnLocalPath(executable, { env, cwd })
  if (!program) {
    return false
  }
  try {
    const help = await runProcess({
      program,
      args: ['--help'],
      cwd,
      env,
      timeoutMs: HELP_PROBE_TIMEOUT_MS
    })
    return help.stdout.includes('--no-daemon')
  } catch {
    return false
  }
}
