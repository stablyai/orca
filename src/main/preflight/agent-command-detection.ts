import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import { canonicalLocalAgentProgram } from '../managed-agent-cli/managed-agent-cli-path'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { INVENTORY_WAIT_MS } from '../../shared/agent-launch/installation/agent-inventory-deadline'
import {
  isAbortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import {
  currentInventoryPublication,
  readInventory,
  type InventorySlot
} from './agent-command-inventory'
import {
  getLocalInventory,
  wslInventory,
  qualifyProgram,
  selectWslTerminalAgentProgram,
  type TerminalAgentProgram,
  type TerminalAgentProgramSelection
} from './agent-command-inventory-host'
export type {
  TerminalAgentProgram,
  TerminalAgentProgramSelection
} from './agent-command-inventory-host'
import {
  completeInventoryAfter,
  isInventoryListCommandSettled
} from './agent-command-inventory-publication'

export const INVENTORY_COMPLETION_WAIT_MS = 60_000

export class AgentInventoryDeadlineError extends Error {
  readonly data?: { afterPublication: number }

  constructor(afterPublication?: number) {
    super('Agent inventory is still running. Try again.')
    if (afterPublication !== undefined) {
      this.data = { afterPublication }
    }
  }
}

export async function withAgentInventoryDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<T> {
  throwIfSignalAborted(signal)
  if (signal && timeoutMs === undefined) {
    return operation(signal)
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new AgentInventoryDeadlineError()),
    timeoutMs ?? INVENTORY_WAIT_MS
  )
  try {
    return await operation(
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function readLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell,
  refresh = false,
  signal?: AbortSignal
): Promise<TerminalAgentProgram> {
  return (await selectTerminalAgentProgram([program], shell, { refresh, signal })).result
}

export async function readWslTerminalAgentProgram(
  target: WslPreflightTarget,
  program: string,
  signal?: AbortSignal
): Promise<TerminalAgentProgram> {
  return (await selectTerminalAgentProgram([program], 'posix', { wsl: target, signal })).result
}

/** Select the first available spelling in the receiving shell. */
export async function selectTerminalAgentProgram(
  programs: readonly [string, ...string[]],
  shell: AgentStartupShell,
  options: {
    wsl?: WslPreflightTarget
    shellPath?: string
    refresh?: boolean
    revalidateUnavailable?: boolean
    verifyWslHit?: boolean
    pinForSetup?: boolean
    signal?: AbortSignal
    onWslDistroSelected?: (distro: string) => void
  }
): Promise<TerminalAgentProgramSelection> {
  const { wsl, refresh, signal, shellPath } = options
  const preferred = programs[0]
  return withAgentInventoryDeadline<TerminalAgentProgramSelection>(async (waitSignal) => {
    if (wsl) {
      return selectWslTerminalAgentProgram(wsl, programs, options, waitSignal)
    }
    const slot = getLocalInventory(shellPath)
    for (let retry = false; ; retry = true) {
      const read = readInventory(slot, programs, refresh || retry ? 'revalidate' : 'read', {
        acceptAnyMatch: true,
        qualifiesEarly: retry
          ? undefined
          : (match) => qualifyProgram(match, shell).kind === 'by-name',
        revalidateUnavailable: options.revalidateUnavailable,
        waitForCompletion: true
      })
      const publication = await read.wait(waitSignal).catch((error: unknown) => {
        if (
          !retry &&
          error instanceof AgentInventoryDeadlineError &&
          isAbortSignalReason(waitSignal, error)
        ) {
          return read.snapshot()
        }
        throw error
      })
      const inventory = publication?.inventory
      if (!inventory || slot !== getLocalInventory(shellPath)) {
        return { program: preferred, result: { kind: 'unknown' } }
      }
      let inconclusive = false
      let rejected = false
      let runtimeHit = false
      for (const program of programs) {
        if (!inventory.probed.has(program)) {
          inconclusive = true
          continue
        }
        const match = inventory.matches.get(program)
        runtimeHit ||= match?.runtimeHit === true
        const result = qualifyProgram(match, shell)
        if ('path' in result) {
          const canonicalPath = await canonicalLocalAgentProgram(result.path, waitSignal)
          if (slot !== getLocalInventory(shellPath) || waitSignal.aborted) {
            return { program, result: { kind: 'unknown' } }
          }
          if (canonicalPath) {
            const cached = !read.scannedMatch?.(program, match)
            const kind = cached ? 'full-path' : result.kind
            return {
              program,
              result: { ...result, kind, ...(options.pinForSetup ? { canonicalPath } : {}) },
              ...(cached ? { cached: true } : {})
            }
          }
          if (retry) {
            return { program, result: { kind: 'unknown' } }
          }
          rejected = true
          break
        }
      }
      if (!rejected) {
        if (options.pinForSetup && !inconclusive && runtimeHit) {
          return { program: preferred, result: { kind: 'unavailable' }, runtimeOnly: true }
        }
        return { program: preferred, result: { kind: inconclusive ? 'unknown' : 'unavailable' } }
      }
    }
  }, signal).catch((): TerminalAgentProgramSelection => ({
    program: preferred,
    result: { kind: 'unknown' }
  }))
}

type CommandDetectionOptions = {
  connectionId?: string | null
  context?: PreflightRuntimeContext
  outsidePath?: Map<string, string>
  onlyRequested?: boolean
  reuseSettled?: boolean
  refresh?: boolean
  afterPublication?: number
  waitForCompletion?: boolean
  signal?: AbortSignal
  prepare?: (signal: AbortSignal) => Promise<void>
}

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options?: CommandDetectionOptions
): Promise<Set<string>> {
  return (await detectAgentCommandInventoryOnHost(commands, options)).found
}

export async function detectAgentCommandInventoryOnHost(
  commands: readonly string[],
  options: CommandDetectionOptions = {}
): Promise<{ found: Set<string>; incomplete?: boolean; afterPublication?: number }> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const wslTarget = getPreflightWslTarget(options.context)
  const targeted = options.onlyRequested ?? false
  const ordinaryMode = targeted && options.reuseSettled ? 'read' : 'detect'
  const allowFallbackMisses = !options.reuseSettled
  const detect = async (waitSignal: AbortSignal) => {
    let slot: InventorySlot | undefined
    let read: ReturnType<typeof readInventory> | undefined
    try {
      slot = wslTarget ? await wslInventory(wslTarget, waitSignal) : getLocalInventory()
      const before = slot?.published?.sequence ?? 0
      throwIfSignalAborted(waitSignal)
      if (slot && !options.refresh && options.afterPublication !== undefined) {
        const completed = completeInventoryAfter(
          currentInventoryPublication(slot, 'complete'),
          options.afterPublication,
          commands,
          allowFallbackMisses
        )
        if (completed) {
          return { slot, publication: completed }
        }
      }
      if (options.prepare) {
        await waitForPromiseWithSignal(options.prepare(waitSignal), waitSignal)
        throwIfSignalAborted(waitSignal)
      }
      if (!slot) {
        return { slot, publication: null }
      }
      const completed = !options.refresh
        ? completeInventoryAfter(
            currentInventoryPublication(slot, 'complete'),
            before,
            commands,
            allowFallbackMisses
          )
        : undefined
      if (completed) {
        return { slot, publication: completed }
      }
      read = readInventory(slot, commands, options.refresh ? 'refresh' : ordinaryMode, {
        targeted,
        allowFallbackMisses,
        afterPublication: options.afterPublication,
        waitForCompletion:
          options.waitForCompletion || (!options.refresh && options.afterPublication !== undefined)
      })
      return { slot, publication: await read.wait(waitSignal) }
    } catch (error) {
      if (error instanceof AgentInventoryDeadlineError && isAbortSignalReason(waitSignal, error)) {
        const published = slot && currentInventoryPublication(slot)
        if (options.waitForCompletion) {
          throw new AgentInventoryDeadlineError(published?.sequence ?? 0)
        }
        const latest = read?.snapshot() ?? published
        return {
          slot,
          publication: {
            sequence: latest?.sequence ?? 0,
            partial: true,
            inventory: {
              found: latest?.inventory.found ?? new Set<string>(),
              matches: latest?.inventory.matches ?? new Map<string, AgentPathMatch>(),
              probed: new Set<string>(),
              incomplete: true
            }
          }
        }
      }
      throw error
    }
  }
  const { slot, publication } = await withAgentInventoryDeadline(
    detect,
    options.signal,
    options.waitForCompletion ? INVENTORY_COMPLETION_WAIT_MS : INVENTORY_WAIT_MS
  )
  if (!publication || slot?.retired || (!wslTarget && slot !== getLocalInventory())) {
    throw new Error(`Could not complete ${wslTarget ? 'WSL' : 'local'} agent inventory`)
  }
  const { inventory } = publication
  const incomplete =
    inventory.incomplete ||
    commands.some((command) => !isInventoryListCommandSettled(inventory, command))
  const afterPublication = publication.partial ? publication.sequence : undefined
  if (incomplete && options.waitForCompletion && (!wslTarget || options.refresh)) {
    throw new AgentInventoryDeadlineError(afterPublication)
  }
  const shell = process.platform === 'win32' ? 'powershell' : 'posix'
  const found = new Set(commands.filter((command) => inventory.found.has(command)))
  if (!wslTarget && options.outsidePath) {
    for (const command of found) {
      const program = qualifyProgram(inventory.matches.get(command), shell)
      if (program.kind === 'full-path') {
        options.outsidePath.set(command, program.path)
      }
    }
  }
  return {
    found,
    ...(incomplete ? { incomplete: true } : {}),
    ...(afterPublication === undefined ? {} : { afterPublication })
  }
}
