// Unit 6: fixture data for MockOrcaServer (spec S6/S9) — hosts/worktrees/notifications/terminal
// shapes mirroring the verified RPC surface (spec Appendix B). Each MockOrcaServer instance owns
// its own copy (via the factory functions) so tests never share mutable fixture state.

export type FixtureWorktreeStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

export type FixtureWorktree = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status: FixtureWorktreeStatus
  lastOutputAt?: number
}

export type FixtureTerminal = {
  terminalId: string
  worktreeId: string
  title: string
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
      liveTerminalCount: 1,
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
  const all: FixtureTerminal[] = [
    { terminalId: 'term-wt1-1', worktreeId: 'wt-1', title: 'claude' },
    { terminalId: 'term-wt2-1', worktreeId: 'wt-2', title: 'codex' }
  ]
  return worktreeId ? all.filter((t) => t.worktreeId === worktreeId) : all
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
