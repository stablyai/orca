// Unit 6: fixture data for MockOrcaServer (spec S6/S9) — hosts/worktrees/notifications/terminal
// shapes mirroring the verified RPC surface (spec Appendix B). Each MockOrcaServer instance owns
// its own copy (via the factory functions) so tests never share mutable fixture state.
import type { RuntimeTerminalSummary } from '@orca-shared/runtime-terminal-contracts'
import type { TuiAgent } from '@orca-shared/tui-agent'

export type FixtureWorktreeStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

export type FixtureWorktree = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status: FixtureWorktreeStatus
  lastOutputAt?: number | null
}

export type FixtureTerminal = {
  terminalId: string
  worktreeId: string
  title: string
  /** Host-resolved agent identity (RuntimeTerminalSummary.agentIdentity); absent means unknown. */
  agentIdentity?: TuiAgent
  lastOutputAt?: number | null
}

export type FixtureNotificationEvent = {
  type: 'notification'
  source: string
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
}

export function createFixtureWorktrees(): FixtureWorktree[] {
  return [
    {
      worktreeId: 'wt-1',
      repo: 'orca',
      branch: 'api-refactor',
      displayName: 'api-refactor',
      liveTerminalCount: 2,
      status: 'working',
      lastOutputAt: Date.now() - 60_000
    },
    {
      worktreeId: 'wt-2',
      repo: 'orca',
      branch: 'hotfix-login',
      displayName: 'hotfix-login',
      liveTerminalCount: 1,
      status: 'done',
      lastOutputAt: Date.now() - 300_000
    }
  ]
}

export function createFixtureTerminals(worktreeId?: string): FixtureTerminal[] {
  const now = Date.now()
  const all: FixtureTerminal[] = [
    {
      terminalId: 'term-wt1-1',
      worktreeId: 'wt-1',
      title: 'claude',
      agentIdentity: 'claude',
      lastOutputAt: now - 60_000
    },
    // Decoy (verifies the CRITICAL agent-terminal-resolution fix, spec S7): newer output than
    // term-wt1-1 but NOT wt-1's designated active/permission-waiting terminal (see
    // createFixtureActiveTerminals) — a "most recent output" heuristic picks this one wrongly;
    // terminal.resolveActive must still resolve to term-wt1-1.
    {
      terminalId: 'term-wt1-2',
      worktreeId: 'wt-1',
      title: 'codex',
      agentIdentity: 'codex',
      lastOutputAt: now - 1_000
    },
    {
      terminalId: 'term-wt2-1',
      worktreeId: 'wt-2',
      title: 'codex',
      agentIdentity: 'codex',
      lastOutputAt: now - 300_000
    }
  ]
  return worktreeId ? all.filter((t) => t.worktreeId === worktreeId) : all
}

/** Host's `terminal.resolveActive` answer per worktree (real RPC: `{worktree} -> {handle}`).
 *  `null` models a worktree the host can't uniquely resolve (ambiguous — fail-closed). */
export function createFixtureActiveTerminals(): Record<string, string | null> {
  return {
    'wt-1': 'term-wt1-1',
    'wt-2': 'term-wt2-1'
  }
}

export const FIXTURE_TERMINAL_SCROLLBACK = '$ pnpm test\nRunning 42 tests...\nAll tests passed.\n'

export function createFixtureNotifications(): FixtureNotificationEvent[] {
  return [
    {
      type: 'notification',
      source: 'claude',
      title: 'Needs input',
      body: 'Approve writing to src/index.ts? [1] Yes [2] No',
      worktreeId: 'wt-1',
      notificationId: 'notif-1'
    }
  ]
}

/** Projects a fixture terminal into the real `terminal.list` row shape (RuntimeTerminalSummary,
 *  spec Appendix B) — `handle`/`agentIdentity`/`lastOutputAt`, not the ad hoc `terminalId` shape. */
export function toFixtureTerminalSummary(
  terminal: FixtureTerminal,
  worktree: FixtureWorktree | undefined,
  overrides: { connected?: boolean; writable?: boolean } = {}
): RuntimeTerminalSummary {
  return {
    handle: terminal.terminalId,
    ptyId: terminal.terminalId,
    worktreeId: terminal.worktreeId,
    worktreePath: worktree
      ? `/mock/${worktree.repo}/${worktree.branch}`
      : `/mock/${terminal.worktreeId}`,
    branch: worktree?.branch ?? terminal.worktreeId,
    tabId: terminal.terminalId,
    leafId: terminal.terminalId,
    title: terminal.title,
    connected: overrides.connected ?? true,
    writable: overrides.writable ?? true,
    lastOutputAt: terminal.lastOutputAt ?? null,
    preview: '',
    ...(terminal.agentIdentity ? { agentIdentity: terminal.agentIdentity } : {})
  }
}
