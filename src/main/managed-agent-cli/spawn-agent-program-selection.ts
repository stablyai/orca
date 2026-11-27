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
import {
  InventoryFsProbes,
  UNVERIFIED_FS_PROBE
} from '../../shared/shell/command-resolution/inventory-fs-probes'
import { checkExecutableFile } from '../ipc/command-path/command-path-directory'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import {
  AgentInventoryDeadlineError,
  selectTerminalAgentProgram,
  withAgentInventoryDeadline,
  type TerminalAgentProgramSelection
} from '../preflight/agent-command-detection'
import {
  canonicalLocalAgentProgram,
  createAgentRuntimeTargetCheck,
  isOrcaAgentRuntimePath
} from './managed-agent-cli-path'

type ConfiguredPathResult = string | null | typeof UNVERIFIED_FS_PROBE
const pendingLookups = new Map<string, PromiseSettlementWaiters<ConfiguredPathResult>>()

export type SpawnProgramContext = {
  launchConfig?: SleepingAgentLaunchConfig
  codexRuntime?: 'host' | 'wsl'
  expectedWslDistro?: string | null
  sshTarget?: boolean
  shellPath?: string
  requirePinnedProgram?: boolean
  setupGate?: boolean
  cwd?: string
  readCwd?: () => Promise<string | undefined>
  env?: NodeJS.ProcessEnv
  preselectedAgentProgram?: PreselectedAgentProgram
  signal?: AbortSignal
}

export type PreselectedAgentProgram = {
  shell: AgentStartupShell
  wslDistro?: string
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
  if (preselected && !spawn.setupGate) {
    const sameRuntime =
      spawn.codexRuntime === 'wsl'
        ? preselected.wslDistro !== undefined &&
          preselected.wslDistro.toLowerCase() === spawn.expectedWslDistro?.toLowerCase()
        : preselected.wslDistro === undefined
    return preselected.shell === shell &&
      sameRuntime &&
      !(shell === 'cmd' && preselected.selection.result.kind === 'by-name') &&
      programs.includes(preselected.selection.program)
      ? preselected.selection
      : unknownSelection
  }
  let wslDistro: string | undefined
  const pinLocally = spawn.setupGate && !spawn.sshTarget && spawn.codexRuntime !== 'wsl'
  let selection = await withAgentInventoryDeadline(async (signal) => {
    const selected = await selectSpawnAgentProgram(
      spawn,
      shell,
      programs,
      launchCwd,
      pinned,
      signal,
      (distro) => {
        wslDistro = distro
      }
    )
    if (!pinLocally || !('path' in selected.result)) {
      return selected
    }
    const canonicalPath =
      selected.result.canonicalPath ??
      (await canonicalLocalAgentProgram(selected.result.path, signal))
    return canonicalPath
      ? { ...selected, result: { ...selected.result, canonicalPath } }
      : unknownSelection
  }, spawn.signal).catch(() => unknownSelection)
  if (onProgramSelected && 'path' in selection.result) {
    // A reused selection cannot establish PATH precedence at the later spawn.
    if (!spawn.sshTarget && selection.result.kind === 'by-name') {
      selection = {
        program: selection.program,
        result: { ...selection.result, kind: 'full-path' }
      }
    }
    onProgramSelected({ shell, wslDistro, selection })
  }
  return selection
}

async function selectSpawnAgentProgram(
  spawn: SpawnProgramContext,
  shell: AgentStartupShell,
  programs: readonly [string, ...string[]],
  launchCwd = '.',
  pinned: string | undefined,
  signal: AbortSignal,
  onWslDistroSelected: (distro: string) => void
): Promise<TerminalAgentProgramSelection> {
  const preferred = programs[0]
  if (spawn.sshTarget) {
    return { program: preferred, result: { kind: 'by-name', path: preferred } }
  }
  if (spawn.codexRuntime === 'wsl') {
    return selectTerminalAgentProgram(programs, shell, {
      wsl: { distro: spawn.expectedWslDistro ?? undefined },
      pinForSetup: spawn.setupGate,
      verifyWslHit: true,
      revalidateUnavailable: true,
      signal,
      onWslDistroSelected
    })
  }
  if (pinned && isAbsolute(pinned)) {
    const probes = new InventoryFsProbes(signal)
    const checked = await checkExecutableFile(pinned, process.platform === 'win32', probes)
    const target = checked === 'executable' ? await probes.realPath(pinned) : null
    const runtime =
      typeof target === 'string' ? await createAgentRuntimeTargetCheck(probes)(target) : target
    if (runtime === false && !isOrcaAgentRuntimePath(pinned)) {
      return { program: preferred, result: { kind: 'full-path', path: pinned } }
    }
    if (checked === 'unknown' || runtime === UNVERIFIED_FS_PROBE) {
      return { program: preferred, result: { kind: 'unknown' } }
    }
  }
  if (spawn.requirePinnedProgram) {
    return { program: preferred, result: { kind: 'unavailable' } }
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
  let configuredPathUnknown = false
  if (configuredEnv) {
    for (const program of programs) {
      const path = await resolveAgentOnConfiguredPath(
        program,
        effective('PATH'),
        effective('PATHEXT'),
        readCwd,
        signal
      )
      if (typeof path === 'string') {
        selection = { program, result: { kind: 'by-name', path } }
        break
      }
      configuredPathUnknown ||= path === UNVERIFIED_FS_PROBE
    }
  }
  selection ??= await selectTerminalAgentProgram(programs, shell, {
    refresh: Boolean(pinned),
    shellPath: spawn.shellPath,
    revalidateUnavailable: true,
    pinForSetup: spawn.setupGate,
    signal
  })
  const { program, result: selected } = selection
  if (!(signal.reason instanceof AgentInventoryDeadlineError)) {
    throwIfSignalAborted(signal)
  }
  if (selected.kind !== 'by-name') {
    return configuredPathUnknown && selected.kind === 'unavailable'
      ? { program, result: { kind: 'unknown' } }
      : selection
  }
  // Pin the selection when the agent's PATH differs from the host inventory's.
  if (configuredEnv) {
    return { program, result: { ...selected, kind: 'full-path' } }
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
): Promise<ConfiguredPathResult> {
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
    const lookup = new PromiseSettlementWaiters<ConfiguredPathResult>(
      Promise.resolve().then(async (): Promise<ConfiguredPathResult> => {
        if (lookup.waiterCount === 0) {
          return null
        }
        const probes = new InventoryFsProbes(controller.signal)
        const isRuntime = createAgentRuntimeTargetCheck(probes)
        let uncertain = false
        const path = await resolveCommandOnLocalPath(program, {
          env: { PATHEXT: pathExt },
          pathEntries,
          signal: controller.signal,
          probeCandidate: async (candidate) => {
            try {
              if (isOrcaAgentRuntimePath(candidate) || lookup.waiterCount === 0) {
                return false
              }
              const checked = await checkExecutableFile(candidate, windows, probes)
              uncertain ||= checked === 'unknown'
              if (checked !== 'executable' || lookup.waiterCount === 0) {
                return false
              }
              const target = await probes.realPath(candidate)
              const runtime = typeof target === 'string' ? await isRuntime(target) : target
              uncertain ||= runtime === UNVERIFIED_FS_PROBE
              return runtime === false
            } finally {
              // Let callers share an issued probe, then stop once no launch is waiting on it.
              if (lookup.waiterCount === 0) {
                controller.abort()
              }
            }
          }
        })
        return path ?? (uncertain ? UNVERIFIED_FS_PROBE : null)
      }),
      () => pendingLookups.delete(key)
    )
    pending = lookup
    pendingLookups.set(key, lookup)
  }
  return pending.wait({ signal, createAbortError: () => abortSignalReason(signal) })
}
