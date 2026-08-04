// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Repo } from '../../../shared/types'

// Why: vi.mock runs before module initialization, so its shared mock must be hoisted too.
const mocks = vi.hoisted(() => ({
  loadAgents: vi.fn()
}))

vi.mock('@/lib/github-issue-launch-agents', () => ({
  loadGitHubIssueLaunchAgents: mocks.loadAgents
}))

import { GitHubIssueWorkspaceLaunchButton } from './GitHubIssueWorkspaceLaunchButton'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1
}

describe('GitHubIssueWorkspaceLaunchButton', () => {
  beforeEach(() => {
    mocks.loadAgents.mockResolvedValue([
      {
        id: 'claude',
        label: 'Claude',
        cmd: 'claude',
        homepageUrl: 'https://claude.ai'
      },
      {
        id: 'codex',
        label: 'Codex',
        cmd: 'codex',
        homepageUrl: 'https://github.com/openai/codex'
      }
    ])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps the primary click on the existing default-agent path', async () => {
    const user = userEvent.setup()
    const onStartDefault = vi.fn()
    const onStartWithAgent = vi.fn()
    render(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={repo}
          onStartDefault={onStartDefault}
          onStartWithAgent={onStartWithAgent}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Start workspace from issue' }))

    expect(onStartDefault).toHaveBeenCalledTimes(1)
    expect(onStartWithAgent).not.toHaveBeenCalled()
    expect(mocks.loadAgents).not.toHaveBeenCalled()
  })

  it('loads configured agents when opened and starts with the selected agent', async () => {
    const user = userEvent.setup()
    const onStartDefault = vi.fn()
    const onStartWithAgent = vi.fn()
    render(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={repo}
          onStartDefault={onStartDefault}
          onStartWithAgent={onStartWithAgent}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Choose an agent for this workspace' }))

    await waitFor(() => expect(mocks.loadAgents).toHaveBeenCalledWith(repo))
    await user.click(await screen.findByRole('menuitem', { name: 'Claude' }))
    expect(onStartWithAgent).toHaveBeenCalledWith('claude')
    expect(onStartDefault).not.toHaveBeenCalled()
  })

  it('ignores an in-flight agent result after the repository changes', async () => {
    let resolveFirst: (agents: Awaited<ReturnType<typeof mocks.loadAgents>>) => void = () => {}
    mocks.loadAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    const user = userEvent.setup()
    const { rerender } = render(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={repo}
          onStartDefault={vi.fn()}
          onStartWithAgent={vi.fn()}
        />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Choose an agent for this workspace' }))

    rerender(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={{ ...repo, id: 'repo-2' }}
          onStartDefault={vi.fn()}
          onStartWithAgent={vi.fn()}
        />
      </TooltipProvider>
    )
    act(() => resolveFirst([{ id: 'claude', label: 'Claude', cmd: 'claude' }]))

    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Claude' })).toBeNull())
  })

  it('loads agents for a repository change while the menu remains open', async () => {
    mocks.loadAgents
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce([{ id: 'codex', label: 'Codex', cmd: 'codex' }])
    const user = userEvent.setup()
    const nextRepo = { ...repo, id: 'repo-2' }
    const { rerender } = render(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={repo}
          onStartDefault={vi.fn()}
          onStartWithAgent={vi.fn()}
        />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Choose an agent for this workspace' }))
    await waitFor(() => expect(mocks.loadAgents).toHaveBeenCalledWith(repo))

    rerender(
      <TooltipProvider>
        <GitHubIssueWorkspaceLaunchButton
          repo={nextRepo}
          onStartDefault={vi.fn()}
          onStartWithAgent={vi.fn()}
        />
      </TooltipProvider>
    )

    await waitFor(() => expect(mocks.loadAgents).toHaveBeenCalledWith(nextRepo))
    expect(await screen.findByRole('menuitem', { name: 'Codex' })).toBeTruthy()
  })
})
