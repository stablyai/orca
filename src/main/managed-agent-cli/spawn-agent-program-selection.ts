import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import {
  abortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import { PromiseSettlementWaiters } from '../../shared/concurrency/promise-settlement-waiters'
import { stripWindowsPathQuotes } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session/lifecycle/agent-session-resume'
import { resolveCmdLaunchFolderProgram } from '../ipc/command-path/cmd-launch-folder-program'
import { checkExecutableFile, isExecutableFile } from '../ipc/command-path/command-path-directory'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import {
  selectTerminalAgentProgram,
  type TerminalAgentProgramSelection
} from '../preflight/agent-command-detection'
import { isOrcaAgentRuntimePath } from './managed-agent-cli-path'

const pendingLookups = new Map<string, PromiseSettlementWaiters<string | null>>()

export type SpawnProgramContext = {
  launchConfig?: SleepingAgentLaunchConfig
  codexRuntime?: 'host' | 'wsl'
  expectedWslDistro?: string | null
  sshTarget?: boolean
  cwd?: string
  readCwd?: () => Promise<string | undefined>
  env?: NodeJS.ProcessEnv
}

export async function selectSpawnAgentProgram(
  spawn: SpawnProgramContext,
  shell: AgentStartupShell,
  programs: readonly [string, ...string[]],
  launchCwd = '.',
  pinned: string | undefined,
  signal: AbortSignal
): Promise<TerminalAgentProgramSelection> {
  const preferred = programs[0]
  if (spawn.sshTarget) {
    return { program: preferred, result: { kind: 'by-name', path: preferred } }
  }
  if (spawn.codexRuntime === 'wsl') {
    return selectTerminalAgentProgram(programs, shell, {
      wsl: { distro: spawn.expectedWslDistro ?? undefined },
      revalidateUnavailable: true,
      signal
    })
  }
  if (pinned && isAbsolute(pinned) && !isOrcaAgentRuntimePath(pinned)) {
    const checked = await waitForPromiseWithSignal(
      checkExecutableFile(pinned, process.platform === 'win32'),
      signal
    )
    if (checked === 'executable') {
      return { program: preferred, result: { kind: 'full-path', path: pinned } }
    }
    if (checked === 'unknown') {
      return { program: preferred, result: { kind: 'unknown' } }
    }
  }
  const readCwd = async (): Promise<string> =>
    isAbsolute(launchCwd)
      ? launchCwd
      : resolve(
          (spawn.readCwd && (await waitForPromiseWithSignal(spawn.readCwd(), signal))) ||
            spawn.cwd ||
            process.cwd(),
          launchCwd
        )
  const agentEnv = spawn.launchConfig?.agentEnv
  const configuredEnv = agentEnv && hasConfiguredAgentPath(agentEnv) ? agentEnv : undefined
  if (configuredEnv) {
    for (const program of programs) {
      const path = await resolveAgentOnConfiguredPath(
        program,
        configuredEnv,
        spawn.env,
        shell,
        readCwd,
        signal
      )
      if (path) {
        return { program, result: { kind: 'full-path', path } }
      }
    }
  }
  const selection = await selectTerminalAgentProgram(programs, shell, {
    refresh: Boolean(pinned),
    revalidateUnavailable: true,
    signal
  })
  const { program, result: selected } = selection
  throwIfSignalAborted(signal)
  if (selected.kind === 'by-name' && configuredEnv) {
    return { program, result: { kind: 'full-path', path: selected.path } }
  }
  if (process.platform !== 'win32' || shell !== 'cmd' || selected.kind !== 'by-name') {
    return selection
  }
  const cwd = await readCwd()
  throwIfSignalAborted(signal)
  const pathExt = readPathEnv(spawn.env, 'PATHEXT') ?? process.env.PATHEXT
  const first = await resolveCmdLaunchFolderProgram(program, cwd, pathExt, signal)
  return first &&
    normalizeRuntimePathForComparison(first) !== normalizeRuntimePathForComparison(selected.path)
    ? { program, result: { kind: 'full-path', path: selected.path } }
    : selection
}

function readPathEnv(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  return process.platform === 'win32'
    ? Object.entries(env ?? {}).find(
        ([name, value]) => name.toUpperCase() === key && value !== undefined
      )?.[1]
    : env?.[key]
}

function hasConfiguredAgentPath(env: NodeJS.ProcessEnv): boolean {
  return (
    readPathEnv(env, 'PATH') !== undefined ||
    (process.platform === 'win32' && readPathEnv(env, 'PATHEXT') !== undefined)
  )
}

async function resolveAgentOnConfiguredPath(
  program: string,
  configuredEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv | undefined,
  shell: AgentStartupShell,
  readCwd: () => Promise<string>,
  signal: AbortSignal
): Promise<string | null> {
  const windows = process.platform === 'win32'
  const effective = (key: string) =>
    readPathEnv(env, key) ?? readPathEnv(configuredEnv, key) ?? readPathEnv(process.env, key)
  const entries = (effective('PATH') ?? '').split(delimiter).filter(Boolean)
  const dirs = windows ? entries.map(stripWindowsPathQuotes) : entries
  const cwd = shell === 'cmd' || dirs.some((dir) => !isAbsolute(dir)) ? await readCwd() : ''
  const pathExt = windows ? effective('PATHEXT') : undefined
  const path = dirs
    .map((dir) => resolve(cwd, dir))
    .filter((dir) => !isOrcaAgentRuntimePath(dir))
    .join(delimiter)
  const searchCwd = shell === 'cmd' ? cwd : ''
  const key = JSON.stringify([program, path, pathExt, searchCwd])
  throwIfSignalAborted(signal)
  let pending = pendingLookups.get(key)
  if (!pending) {
    const controller = new AbortController()
    const lookup = new PromiseSettlementWaiters<string | null>(
      Promise.resolve().then((): Promise<string | null> | null => {
        if (lookup.waiterCount === 0) {
          return null
        }
        return resolveCommandOnLocalPath(program, {
          env: { PATH: path, PATHEXT: pathExt },
          cwd: searchCwd,
          signal: controller.signal,
          probeCandidate: async (candidate) => {
            try {
              if (
                isOrcaAgentRuntimePath(candidate) ||
                !(await isExecutableFile(candidate, windows)) ||
                lookup.waiterCount === 0
              ) {
                return false
              }
              const target = await realpath(candidate).catch(() => undefined)
              return Boolean(target && !isOrcaAgentRuntimePath(target))
            } finally {
              // Let callers share an issued probe, then stop once no launch is waiting on it.
              if (lookup.waiterCount === 0) {
                controller.abort()
              }
            }
          }
        })
      }),
      () => pendingLookups.delete(key)
    )
    pending = lookup
    pendingLookups.set(key, lookup)
  }
  return pending.wait({ signal, createAbortError: () => abortSignalReason(signal) })
}
