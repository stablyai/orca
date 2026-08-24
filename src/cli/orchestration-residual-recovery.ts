type ResidualResource = {
  kind?: unknown
  role?: unknown
  action?: unknown
  id?: unknown
}

type WorkerStartReceiptShape = {
  state?: unknown
  dispatchId?: unknown
  server?: unknown
  residualResources?: unknown
  nextCommands?: unknown
  recoveryCommands?: unknown
}

export type WorkerStartRecovery = {
  note: string
  commands: string[]
}

// Why: the runtime records ownership 'created' for the terminal a start made itself, including
// agent-first worktree creation, whose effect says 'reused_agent_terminal'. Any other action —
// a '--terminal' adoption, or a value this CLI does not know — is not provably this Dispatch's.
const OWNED_AGENT_TERMINAL_ACTIONS = ['created', 'reused_agent_terminal']

// Why: these commands are printed for a human to paste into an unknown shell — PowerShell, a POSIX
// shell over SSH, WSL — which the rendering process cannot identify, so no quoting is provably
// inert. An id outside this class earns no command instead.
const SHELL_NEUTRAL_ID = /^[a-zA-Z0-9._:/@-]+$/

/**
 * Reclaim guidance for a worker-start receipt, or undefined when nothing is provably reclaimable.
 * Every command routes through the Dispatch so the host re-checks ownership and picks the host
 * that actually holds the terminal; the CLI never closes a handle on its own reading of effects.
 */
export function workerStartRecovery(receipt: unknown): WorkerStartRecovery | undefined {
  const value = objectRecord(receipt) as WorkerStartReceiptShape | undefined
  // Why: only a definitively failed start has residue. 'ready' owns a live worker, and
  // 'outcome_unknown' may too — reclaim guidance there can kill a worker that did start.
  if (!value || value.state !== 'failed') {
    return undefined
  }
  // Why: a host that ships its own commands knows its own ownership rules; adding ours to a
  // receipt shaped by a different version would be a guess layered on top of an authority.
  if (hasCommands(value.nextCommands) || hasCommands(value.recoveryCommands)) {
    return undefined
  }
  const dispatchId = value.dispatchId
  if (typeof dispatchId !== 'string' || !SHELL_NEUTRAL_ID.test(dispatchId)) {
    return undefined
  }
  if (!Array.isArray(value.residualResources)) {
    return undefined
  }
  const owned = value.residualResources.filter(isOwnedAgentTerminal)
  if (owned.length === 0) {
    return undefined
  }
  const server = objectRecord(value.server)
  if (server) {
    const name = typeof server.name === 'string' ? server.name : 'the connected server'
    return {
      note: `The residual terminal belongs to worker server ${name}, not this Orca server; a local terminal close would target the wrong host. Inspect the Dispatch and clean up on that server:`,
      commands: [`orca orchestration worker-show --dispatch ${dispatchId} --json`]
    }
  }
  return {
    note: 'Reclaim the terminal this failed start created through its Dispatch, so Orca preserves the output and closes only what it can prove this Dispatch owns:',
    commands: [`orca orchestration worker-release --dispatch ${dispatchId} --json`]
  }
}

function isOwnedAgentTerminal(resource: unknown): boolean {
  const value = objectRecord(resource) as ResidualResource | undefined
  if (!value || value.kind !== 'terminal' || value.role !== 'agent') {
    return false
  }
  return (
    typeof value.action === 'string' &&
    OWNED_AGENT_TERMINAL_ACTIONS.includes(value.action) &&
    typeof value.id === 'string' &&
    value.id.length > 0
  )
}

function hasCommands(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
