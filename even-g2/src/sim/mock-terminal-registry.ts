// Unit 6: fixture-backed terminal bookkeeping for MockOrcaServer — scrollback buffers,
// terminal.resolveActive answers, and the writable/refused-send scenario knob. Pulled out of
// MockOrcaServer so the connection/encryption plumbing there stays under the file's line budget.
import type {
  RuntimeTerminalAgentStatusState,
  RuntimeTerminalSummary
} from '@orca-shared/runtime-terminal-contracts'
import {
  createFixtureActiveTerminals,
  createFixtureTerminals,
  toFixtureTerminalSummary,
  type FixtureWorktree
} from './mock-orca-fixtures'

export class MockTerminalRegistry {
  private readonly buffers = new Map<string, string>()
  private readonly activeTerminals: Map<string, string | null>
  private readonly unwritableTerminals = new Set<string>()
  private readonly needsInputOverrides = new Map<string, boolean>()

  constructor(
    initialScrollback: string,
    private readonly worktrees: readonly FixtureWorktree[]
  ) {
    this.activeTerminals = new Map(Object.entries(createFixtureActiveTerminals()))
    for (const terminal of createFixtureTerminals()) {
      this.buffers.set(terminal.terminalId, initialScrollback)
    }
  }

  // ---- scenario controls -------------------------------------------------------------------

  /** Overrides `terminal.resolveActive`'s answer for `worktreeId`; `null` models an ambiguous
   *  resolution the host can't disambiguate (fail-closed — no unique candidate proven). */
  setActiveTerminal(worktreeId: string, terminalId: string | null): void {
    this.activeTerminals.set(worktreeId, terminalId)
  }

  /** Makes `terminal.send` to `terminalId` come back `accepted: false` (e.g. a disconnected or
   *  read-only terminal) until re-enabled. */
  setTerminalWritable(terminalId: string, writable: boolean): void {
    if (writable) {
      this.unwritableTerminals.delete(terminalId)
    } else {
      this.unwritableTerminals.add(terminalId)
    }
  }

  /** Overrides `terminal.agentStatus`'s `status` for `terminalId` (CRITICAL finding #1:
   *  agent-terminal-resolution.ts resolves the worktree's unique `status === 'permission'`
   *  terminal from this, never terminal.resolveActive). Unset means "derive from
   *  setActiveTerminal" — the fixture's designated active terminal is the one needing input by
   *  default. `true` -> 'permission', `false` -> 'working' (a plain non-waiting agent state). */
  setNeedsInput(terminalId: string, needsInput: boolean): void {
    this.needsInputOverrides.set(terminalId, needsInput)
  }

  /** Real `RuntimeTerminalAgentStatus.status` (src/shared/runtime-terminal-contracts.ts) — the
   *  mock's terminal.agentStatus handler wraps this in the real `{handle,isRunningAgent,status}`
   *  shape so drift from the verified contract is a compile error, not a silent mock fiction. */
  agentStatusFor(terminalId: string): RuntimeTerminalAgentStatusState {
    const override = this.needsInputOverrides.get(terminalId)
    if (override !== undefined) {
      return override ? 'permission' : 'working'
    }
    const terminal = createFixtureTerminals().find((t) => t.terminalId === terminalId)
    if (terminal === undefined) {
      return null
    }
    return this.resolveActive(terminal.worktreeId) === terminalId ? 'permission' : 'working'
  }

  // ---- RPC-facing queries -------------------------------------------------------------------

  listSummaries(worktreeId?: string): RuntimeTerminalSummary[] {
    return createFixtureTerminals(worktreeId).map((terminal) =>
      toFixtureTerminalSummary(
        terminal,
        this.worktrees.find((w) => w.worktreeId === terminal.worktreeId),
        { writable: !this.unwritableTerminals.has(terminal.terminalId) }
      )
    )
  }

  resolveActive(worktreeId: string): string | null {
    return this.activeTerminals.get(worktreeId) ?? null
  }

  isWritable(terminalId: string): boolean {
    return !this.unwritableTerminals.has(terminalId)
  }

  // ---- output buffer ------------------------------------------------------------------------

  getBuffer(terminalId: string): string {
    return this.buffers.get(terminalId) ?? ''
  }

  appendOutput(terminalId: string, text: string): void {
    this.buffers.set(terminalId, this.getBuffer(terminalId) + text)
  }
}
