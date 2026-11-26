import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import type { AgentPathMatch } from '../ipc/command-path/command-path-batch'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  isAbortSignalReason,
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import {
  currentInventoryPublication,
  INVENTORY_WAIT_MS,
  readInventory,
  type InventorySlot
} from './agent-command-inventory'
import { getLocalInventory, wslInventory } from './agent-command-inventory-host'

const INVENTORY_COMPLETION_WAIT_MS = 60_000

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

export type TerminalAgentProgram =
  | { kind: 'by-name' | 'full-path'; path: string }
  | { kind: 'unavailable' | 'unknown' }

export type TerminalAgentProgramSelection = { program: string; result: TerminalAgentProgram }

function qualifyProgram(
  match: AgentPathMatch | undefined,
  shell: AgentStartupShell
): TerminalAgentProgram {
  if (!match?.user) {
    return { kind: 'unavailable' }
  }
  const winner = shell === 'powershell' ? match.unquoted : match.first
  return winner && !isOrcaAgentRuntimePath(winner)
    ? { kind: 'by-name', path: winner }
    : { kind: 'full-path', path: match.user }
}

export function readPublishedLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell
): TerminalAgentProgram {
  const inventory = currentInventoryPublication(getLocalInventory())?.inventory
  return inventory?.probed.has(program)
    ? qualifyProgram(inventory.matches.get(program), shell)
    : { kind: 'unknown' }
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

/** Select the first available spelling from one inventory read in the receiving shell. */
export async function selectTerminalAgentProgram(
  programs: readonly [string, ...string[]],
  shell: AgentStartupShell,
  options: {
    wsl?: WslPreflightTarget
    refresh?: boolean
    revalidateUnavailable?: boolean
    signal?: AbortSignal
  }
): Promise<TerminalAgentProgramSelection> {
  const { wsl, refresh, signal } = options
  const preferred = programs[0]
  return withAgentInventoryDeadline<TerminalAgentProgramSelection>(async (waitSignal) => {
    const slot = wsl ? await wslInventory(wsl, waitSignal) : getLocalInventory()
    throwIfSignalAborted(waitSignal)
    const read = slot
      ? readInventory(slot, programs, refresh ? 'revalidate' : 'read', {
          acceptAnyMatch: true,
          revalidateUnavailable: options.revalidateUnavailable,
          waitForCompletion: true
        })
      : undefined
    const publication = read
      ? await read.wait(waitSignal).catch((error: unknown) => {
          if (
            !wsl &&
            error instanceof AgentInventoryDeadlineError &&
            isAbortSignalReason(waitSignal, error)
          ) {
            return read.snapshot()
          }
          throw error
        })
      : null
    const inventory = publication?.inventory
    if (!inventory || (!wsl && slot !== getLocalInventory())) {
      return { program: preferred, result: { kind: 'unknown' } }
    }
    let inconclusive = false
    for (const program of programs) {
      if (!inventory.probed.has(program)) {
        inconclusive = true
        continue
      }
      const result: TerminalAgentProgram = wsl
        ? inventory.found.has(program)
          ? { kind: 'by-name', path: program }
          : { kind: 'unavailable' }
        : qualifyProgram(inventory.matches.get(program), shell)
      if (result.kind !== 'unavailable') {
        return { program, result }
      }
    }
    return { program: preferred, result: { kind: inconclusive ? 'unknown' : 'unavailable' } }
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

function completeInventoryAfter(
  slot: InventorySlot,
  sequence: number,
  commands: readonly string[]
) {
  const latest = currentInventoryPublication(slot, 'complete')
  return latest &&
    latest.sequence > sequence &&
    !latest.inventory.incomplete &&
    commands.every((command) => latest.inventory.probed.has(command))
    ? latest
    : undefined
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
  const ordinaryMode = targeted ? 'read' : 'detect'
  const refreshMode = targeted ? 'revalidate' : 'refresh'
  const detect = async (waitSignal: AbortSignal) => {
    let slot: InventorySlot | undefined
    let read: ReturnType<typeof readInventory> | undefined
    try {
      slot = wslTarget ? await wslInventory(wslTarget, waitSignal) : getLocalInventory()
      const before = slot?.published?.sequence ?? 0
      throwIfSignalAborted(waitSignal)
      if (slot && !options.refresh && options.afterPublication !== undefined) {
        const completed = completeInventoryAfter(slot, options.afterPublication, commands)
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
        ? completeInventoryAfter(slot, before, commands)
        : undefined
      if (completed) {
        return { slot, publication: completed }
      }
      read = readInventory(slot, commands, options.refresh ? refreshMode : ordinaryMode, {
        targeted,
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
  if (!publication || (!wslTarget && slot !== getLocalInventory())) {
    throw new Error(`Could not complete ${wslTarget ? 'WSL' : 'local'} agent inventory`)
  }
  const { inventory } = publication
  const incomplete =
    inventory.incomplete || commands.some((command) => !inventory.probed.has(command))
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
