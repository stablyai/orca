import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: () => false
}))

function entry(updateIssue: ReturnType<typeof vi.fn>): LinearClientForWorkspace {
  return {
    workspace: { id: 'workspace-1', organizationName: 'Acme' },
    client: { updateIssue, client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function issue(cycle: { id: string; name: string } | null) {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix thing',
    url: 'https://linear.app/ENG-1',
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-1', name: 'Todo' },
    parent: null,
    cycle
  }
}

describe('Linear issue cycle writes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the cycle ID and reads the assigned cycle back', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    rawRequest.mockResolvedValueOnce({ data: { issue: issue({ id: 'cycle-7', name: 'Cycle 7' }) } })
    getClients.mockReturnValue([entry(updateIssue)])
    const { updateIssueForAgent } = await import('./issues')

    await expect(
      updateIssueForAgent('issue-1', { cycleId: 'cycle-7' }, 'workspace-1')
    ).resolves.toMatchObject({ cycle: { id: 'cycle-7', name: 'Cycle 7' } })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', { cycleId: 'cycle-7' })
    expect(rawRequest.mock.calls[0]?.[0]).toContain('cycle { id name }')
  })

  it('passes null through and confirms the cycle is clear', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    rawRequest.mockResolvedValueOnce({ data: { issue: issue(null) } })
    getClients.mockReturnValue([entry(updateIssue)])
    const { updateIssueForAgent } = await import('./issues')

    await expect(
      updateIssueForAgent('issue-1', { cycleId: null }, 'workspace-1')
    ).resolves.toMatchObject({ cycle: null })
    expect(updateIssue).toHaveBeenCalledWith('issue-1', { cycleId: null })
  })
})
