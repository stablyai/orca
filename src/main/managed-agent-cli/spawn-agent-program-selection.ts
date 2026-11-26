import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import {
  abortSignalReason,
  isAbortSignalReason,
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
  AgentInventoryDeadlineError,
  selectTerminalAgentProgram,
  withAgentInventoryDeadline,
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
  preselectedAgentProgram?: PreselectedAgentProgram
}

export type PreselectedAgentProgram = {
  shell: AgentStartupShell
  wslDistro?: string | null
  cmdCwd?: string
  selection: TerminalAgentProgramSelection
}

export async function resolveSpawnAgentProgram(
  spawn: SpawnProgramContext,
  shell: AgentStartupShell,
  programs: readonly [string, ...string[]],
  launchCwd: string | undefined,
  pinned: string | undefined,
  onProgramSelected?: (program: PreselectedAgentProgram) => void
): Promise<TerminalAgentProgramSelection> {
  const unknownSelection: TerminalAgentProgramSelection = {
    program: programs[0],
    result: { kind: 'unknown' }
  }
  const preselected = spawn.preselectedAgentProgram
  const wslDistro =
    spawn.codexRuntime === 'wsl' ? (spawn.expectedWslDistro?.toLowerCase() ?? null) : undefined
  const cmdCwd =
    shell === 'cmd' && (onProgramSelected || preselected)
      ? resolve(spawn.cwd ?? process.cwd(), launchCwd ?? '.')
      : undefined
  if (preselected) {
    return preselected.shell === shell &&
      preselected.wslDistro === wslDistro &&
      (preselected.selection.result.kind !== 'by-name' || preselected.cmdCwd === cmdCwd) &&
      programs.includes(preselected.selection.program)
      ? preselected.selection
      : unknownSelection
  }
  const selection = await withAgentInventoryDeadline((signal) =>
    selectSpawnAgentProgram(spawn, shell, programs, launchCwd, pinned, signal)
  ).catch(() => unknownSelection)
  if ('path' in selection.result) {
    onProgramSelected?.({ shell, wslDistro, cmdCwd, selection })
  }
  return selection
}

async function selectSpawnAgentProgram(
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
  const effective = (key: string) =>
    readPathEnv(spawn.env, key) ?? readPathEnv(configuredEnv, key) ?? readPathEnv(process.env, key)
  let selection: TerminalAgentProgramSelection | undefined
  if (configuredEnv) {
    for (const program of programs) {
      const path = await resolveAgentOnConfiguredPath(
        program,
        effective('PATH'),
        effective('PATHEXT'),
        readCwd,
        signal
      )
      if (path) {
        selection = { program, result: { kind: 'by-name', path } }
        break
      }
    }
  }
  selection ??= await selectTerminalAgentProgram(programs, shell, {
    refresh: Boolean(pinned),
    revalidateUnavailable: true,
    signal
  })
  const { program, result: selected } = selection
  if (!(signal.reason instanceof AgentInventoryDeadlineError)) {
    throwIfSignalAborted(signal)
  }
  if (selected.kind !== 'by-name') {
    return selection
  }
  // Pin the selection when the agent's PATH differs from the host inventory's.
  if (configuredEnv) {
    return { program, result: { kind: 'full-path', path: selected.path } }
  }
  if (process.platform === 'win32' && shell === 'cmd') {
    try {
      throwIfSignalAborted(signal)
      const first = await resolveCmdLaunchFolderProgram(
        program,
        await readCwd(),
        effective('PATHEXT'),
        signal
      )
      if (
        !first ||
        normalizeRuntimePathForComparison(first) ===
          normalizeRuntimePathForComparison(selected.path)
      ) {
        return selection
      }
    } catch (error) {
      if (!(error instanceof AgentInventoryDeadlineError && isAbortSignalReason(signal, error))) {
        throw error
      }
    }
    return { program, result: { kind: 'full-path', path: selected.path } }
  }
  return selection
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
  pathEnv: string | undefined,
  pathExt: string | undefined,
  readCwd: () => Promise<string>,
  signal: AbortSignal
): Promise<string | null> {
  const windows = process.platform === 'win32'
  const entries = pathEnv?.split(delimiter) ?? []
  const dirs = windows ? entries.filter(Boolean).map(stripWindowsPathQuotes) : entries
  const cwd = dirs.some((dir) => !isAbsolute(dir)) ? await readCwd() : ''
  const pathEntries = dirs
    .map((dir) => resolve(cwd, dir))
    .filter((dir) => !isOrcaAgentRuntimePath(dir))
  const key = JSON.stringify([program, pathEntries, pathExt])
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
          env: { PATHEXT: pathExt },
          pathEntries,
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
