// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { findMovableClaudeSessions } from '@/lib/claude-session-account-move'
import {
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from '@/lib/claude-account-switch-sessions'
import ClaudeAccountSwitchDialog from './ClaudeAccountSwitchDialog'
import type * as AccountMove from '@/lib/claude-session-account-move'

vi.mock('@/lib/claude-session-account-move', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountMove>()),
  findMovableClaudeSessions: vi.fn(),
  findQueuedClaudeRestartsOnAccount: () => [],
  isClaudePaneMidTurn: () => false
}))

const LEAF = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const candidate = (n: number) => ({
  ptyId: `pty-${n}`,
  worktreeId: 'wt-1',
  tabId: `tab-${n}`,
  leafId: LEAF(n)
})
const row = (id: string) => ({
  id,
  email: `${id}@example.com`,
  authMethod: 'subscription-oauth' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
})
const ROSTER = { accounts: [row('account-a'), row('account-b')] }
const updateSettings = vi.fn(async () => {})

async function switchWith(count: number, from = 'account-a', to = 'account-b'): Promise<void> {
  vi.mocked(findMovableClaudeSessions).mockResolvedValue(
    Array.from({ length: count }, (_, index) => candidate(index + 1))
  )
  await act(async () => {
    await handleRunningClaudeSessionsAfterSwitch({
      owner: { kind: 'local' },
      target: { runtime: 'host' },
      before: { state: ROSTER, accountId: from },
      after: { state: ROSTER, accountId: to }
    })
  })
}

const queued = (): Record<string, string> => useAppStore.getState().pendingPaneAccountRestarts

describe('ClaudeAccountSwitchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    useAppStore.setState({
      updateSettings,
      pendingPaneAccountRestarts: {},
      terminalLayoutsByTabId: Object.fromEntries(
        [1, 2, 3].map((n) => [
          `tab-${n}`,
          {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF(n)]: `pty-${n}` }
          }
        ])
      )
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('stays closed when no session needs restarting', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(0)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names both accounts and offers to restart every session', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(2)

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Switched to account-b@example.com')).toBeTruthy()
    expect(
      screen.getByText(
        '2 Claude sessions are still running on account-a@example.com. Restarting continues each conversation on account-b@example.com. Busy sessions wait for idle before restarting.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep as is' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart 2 sessions' })).toBeTruthy()
  })

  it('uses singular copy for one session', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    expect(screen.getByRole('button', { name: 'Restart session' })).toBeTruthy()
  })

  it('answers Keep as is on Escape', async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(queued()).toEqual({})
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it("carries Don't ask again into an Escape", async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    await user.click(screen.getByRole('checkbox', { name: /Don't ask again/ }))
    await user.keyboard('{Escape}')

    expect(queued()).toEqual({})
    expect(updateSettings).toHaveBeenCalledWith({ claudeAccountSwitchRunningSessions: 'restart' })
  })

  it("restarts every session and saves Don't ask again", async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(2)

    await user.click(screen.getByRole('checkbox', { name: /Don't ask again/ }))
    await user.click(screen.getByRole('button', { name: 'Restart 2 sessions' }))

    expect(queued()).toEqual({ 'pty-1': 'claude', 'pty-2': 'claude' })
    expect(updateSettings).toHaveBeenCalledWith({ claudeAccountSwitchRunningSessions: 'restart' })
  })

  it('restarts only the sessions left ticked', async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(3)

    await user.click(screen.getAllByRole('checkbox', { name: 'Claude session' })[0])
    await user.click(screen.getByRole('button', { name: 'Restart 2 sessions' }))

    expect(queued()).toEqual({ 'pty-2': 'claude', 'pty-3': 'claude' })
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it("asks a newer switch afresh, with Don't ask again and every session reset", async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(3)
    await user.click(screen.getByRole('checkbox', { name: /Don't ask again/ }))
    await user.click(screen.getAllByRole('checkbox', { name: 'Claude session' })[0])

    await switchWith(3, 'account-b', 'account-a')

    expect(screen.getByText('Switched to account-a@example.com')).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: /Don't ask again/ }).getAttribute('aria-checked')
    ).toBe('false')
    expect(screen.getByRole('button', { name: 'Restart 3 sessions' })).toBeTruthy()
  })

  it('shows no session list for a single session', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    expect(screen.queryByRole('tree')).toBeNull()
  })
})
