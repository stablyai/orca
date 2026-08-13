// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { Repo, TuiAgent } from '../../../shared/types'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude', 'codex'] as TuiAgent[] | null,
  detectionFailed: false,
  targets: [] as unknown[]
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => {
    detectedAgentsMock.targets.push(target)
    return {
      detectedIds: detectedAgentsMock.detectedIds,
      isLoading: detectedAgentsMock.detectedIds === null,
      detectionFailed: detectedAgentsMock.detectionFailed,
      isRefreshing: false,
      refresh: vi.fn()
    }
  }
}))

import { GitHubIssueWorkspaceLaunchButton } from './GitHubIssueWorkspaceLaunchButton'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1
}

function renderButton(
  props: Partial<React.ComponentProps<typeof GitHubIssueWorkspaceLaunchButton>> = {}
) {
  const onStartDefault = vi.fn()
  const onStartWithAgent = vi.fn()
  const view = render(
    <TooltipProvider>
      <GitHubIssueWorkspaceLaunchButton
        repo={repo}
        onStartDefault={onStartDefault}
        onStartWithAgent={onStartWithAgent}
        {...props}
      />
    </TooltipProvider>
  )
  return { ...view, onStartDefault, onStartWithAgent }
}

function openMenu(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole('button', { name: 'Choose an agent for this workspace' }))
}

/** Every distinct host probed — a second host here means a stray extra probe. */
function uniqueTargets(): unknown[] {
  const seen = new Map<string, unknown>()
  for (const target of detectedAgentsMock.targets) {
    seen.set(JSON.stringify(target ?? null), target)
  }
  return [...seen.values()]
}

describe('GitHubIssueWorkspaceLaunchButton', () => {
  beforeEach(() => {
    detectedAgentsMock.detectedIds = ['claude', 'codex']
    detectedAgentsMock.detectionFailed = false
    detectedAgentsMock.targets = []
    useAppStore.setState({ repos: [repo], settings: { disabledTuiAgents: [] } } as never)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps the primary click on the existing default-agent path', async () => {
    const user = userEvent.setup()
    const { onStartDefault, onStartWithAgent } = renderButton()

    await user.click(screen.getByRole('button', { name: 'Start workspace from issue' }))

    expect(onStartDefault).toHaveBeenCalledTimes(1)
    expect(onStartWithAgent).not.toHaveBeenCalled()
  })

  it('detects nothing until the menu opens', async () => {
    const user = userEvent.setup()
    renderButton()
    expect(detectedAgentsMock.targets).toEqual([])

    await openMenu(user)

    expect(uniqueTargets()).toEqual([{ kind: 'local' }])
  })

  it('starts with the selected agent', async () => {
    const user = userEvent.setup()
    const { onStartDefault, onStartWithAgent } = renderButton()

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: 'Claude' }))

    expect(onStartWithAgent).toHaveBeenCalledWith('claude')
    expect(onStartDefault).not.toHaveBeenCalled()
  })

  it('detects on the repository owning SSH host, not the local machine', async () => {
    const sshRepo = { ...repo, connectionId: 'ssh-host-1' }
    useAppStore.setState({ repos: [sshRepo] } as never)
    const user = userEvent.setup()
    renderButton({ repo: sshRepo })

    await openMenu(user)

    expect(uniqueTargets()).toEqual([{ kind: 'ssh', connectionId: 'ssh-host-1' }])
  })

  it('detects on the repository owning runtime host', async () => {
    const runtimeRepo = { ...repo, executionHostId: 'runtime:env-9' as const }
    useAppStore.setState({ repos: [runtimeRepo] } as never)
    const user = userEvent.setup()
    renderButton({ repo: runtimeRepo })

    await openMenu(user)

    expect(uniqueTargets()).toEqual([{ kind: 'runtime', environmentId: 'env-9' }])
  })

  // Why: a hostless repo in a paired session belongs to the focused runtime.
  // Detecting locally there offers the client's agents, and the composer the
  // menu opens then refuses to start them.
  it('detects on the focused runtime for a repository with no explicit host', async () => {
    useAppStore.setState({
      repos: [repo],
      settings: { disabledTuiAgents: [], activeRuntimeEnvironmentId: 'env-paired' }
    } as never)
    const user = userEvent.setup()
    renderButton()

    await openMenu(user)

    expect(uniqueTargets()).toEqual([{ kind: 'runtime', environmentId: 'env-paired' }])
  })

  // Why: two repos can share a bare id across hosts. Re-resolving by id alone
  // picks the focused duplicate and probes a host this row does not belong to.
  it('keeps the row own host when another repo shares its id on the focused runtime', async () => {
    const localRepo = { ...repo, executionHostId: 'local' as const }
    useAppStore.setState({
      repos: [localRepo, { ...repo, executionHostId: 'runtime:env-9' as const }],
      settings: { disabledTuiAgents: [], activeRuntimeEnvironmentId: 'env-9' }
    } as never)
    const user = userEvent.setup()
    renderButton({ repo: localRepo })

    await openMenu(user)

    expect(uniqueTargets()).toEqual([{ kind: 'local' }])
  })

  it('hides agents the user disabled in settings', async () => {
    useAppStore.setState({ settings: { disabledTuiAgents: ['codex'] } } as never)
    const user = userEvent.setup()
    renderButton()

    await openMenu(user)

    expect(await screen.findByRole('menuitem', { name: 'Claude' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Codex' })).toBeNull()
  })

  it('shows a detecting state until the host answers', async () => {
    detectedAgentsMock.detectedIds = null
    const user = userEvent.setup()
    renderButton()

    await openMenu(user)

    expect(await screen.findByText('Detecting agents…')).toBeTruthy()
  })

  it('reports a failed remote detection instead of an empty agent list', async () => {
    detectedAgentsMock.detectedIds = null
    detectedAgentsMock.detectionFailed = true
    const user = userEvent.setup()
    renderButton()

    await openMenu(user)

    expect(await screen.findByText('Unable to load agents')).toBeTruthy()
  })

  it('reports an unavailable repository host instead of detecting locally', async () => {
    const user = userEvent.setup()
    renderButton({ repo: null })

    await openMenu(user)

    expect(await screen.findByText('Unable to load agents')).toBeTruthy()
    expect(detectedAgentsMock.targets).toEqual([undefined])
  })

  it('says no agents are available when the host has none enabled', async () => {
    detectedAgentsMock.detectedIds = []
    const user = userEvent.setup()
    renderButton()

    await openMenu(user)

    expect(await screen.findByText('No agents available')).toBeTruthy()
  })
})
