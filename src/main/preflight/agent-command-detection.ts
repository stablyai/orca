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
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import { localInventory, readInventory, wslInventory } from './agent-command-inventory'

const INVENTORY_WAIT_MS = 10_000

export async function withAgentInventoryDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal) {
    throwIfSignalAborted(signal)
    return operation(signal)
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Agent inventory is still running. Try again.')),
    INVENTORY_WAIT_MS
  )
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export type TerminalAgentProgram =
  | { kind: 'by-name' | 'full-path'; path: string }
  | { kind: 'unavailable' | 'unknown' }

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

export async function readLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell,
  refresh = false,
  signal?: AbortSignal
): Promise<TerminalAgentProgram> {
  return withAgentInventoryDeadline<TerminalAgentProgram>(async (waitSignal) => {
    const slot = localInventory()
    const inventory = await waitForPromiseWithSignal(
      readInventory(slot, [program], refresh ? 'revalidate' : 'read'),
      waitSignal
    )
    return slot === localInventory() && inventory?.probed.has(program)
      ? qualifyProgram(inventory.matches.get(program), shell)
      : { kind: 'unknown' }
  }, signal).catch((): TerminalAgentProgram => ({ kind: 'unknown' }))
}

export async function readWslTerminalAgentProgram(
  target: WslPreflightTarget,
  program: string,
  signal?: AbortSignal
): Promise<TerminalAgentProgram> {
  return withAgentInventoryDeadline<TerminalAgentProgram>(async (waitSignal) => {
    const slot = await wslInventory(target, waitSignal)
    throwIfSignalAborted(waitSignal)
    const inventory = slot
      ? await waitForPromiseWithSignal(readInventory(slot, [program], 'read'), waitSignal)
      : null
    if (!inventory?.probed.has(program)) {
      return { kind: 'unknown' }
    }
    return inventory.found.has(program)
      ? { kind: 'by-name', path: program }
      : { kind: 'unavailable' }
  }, signal).catch((): TerminalAgentProgram => ({ kind: 'unknown' }))
}

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    outsidePath?: Map<string, string>
    onlyRequested?: boolean
    refresh?: boolean
    signal?: AbortSignal
  } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const wslTarget = getPreflightWslTarget(options.context)
  const targeted = options.onlyRequested ?? false
  const ordinaryMode = targeted ? 'read' : 'detect'
  const refreshMode = targeted ? 'revalidate' : 'refresh'
  const { slot, inventory } = await withAgentInventoryDeadline(async (waitSignal) => {
    const slot = wslTarget ? await wslInventory(wslTarget, waitSignal) : localInventory()
    throwIfSignalAborted(waitSignal)
    const inventory = slot
      ? await waitForPromiseWithSignal(
          readInventory(slot, commands, options.refresh ? refreshMode : ordinaryMode, targeted),
          waitSignal
        )
      : null
    return { slot, inventory }
  }, options.signal)
  if (
    !inventory ||
    (!wslTarget && slot !== localInventory()) ||
    (inventory.incomplete &&
      commands.length > 0 &&
      !commands.some((cmd) => inventory.probed.has(cmd)))
  ) {
    throw new Error(`Could not complete ${wslTarget ? 'WSL' : 'local'} agent inventory`)
  }
  if (wslTarget) {
    return new Set(commands.filter((cmd) => inventory.found.has(cmd)))
  }
  const shell = process.platform === 'win32' ? 'powershell' : 'posix'
  return new Set(
    commands.filter((command) => {
      const program = qualifyProgram(inventory.matches.get(command), shell)
      if (program.kind === 'full-path') {
        options.outsidePath?.set(command, program.path)
      }
      return inventory.found.has(command)
    })
  )
}
