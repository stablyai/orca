/* eslint-disable max-lines -- Why: label catalog API tests cover reads,
   mutations, workspace selection, auth clearing, and SDK payload shapes together. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const getStatus = vi.fn()
const acquire = vi.fn().mockResolvedValue(undefined)
const release = vi.fn()

vi.mock('./client', () => ({
  acquire: () => acquire(),
  release: () => release(),
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: (...args: unknown[]) => getStatus(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

function makeEntry(overrides: Partial<LinearClientForWorkspace> = {}): LinearClientForWorkspace {
  const defaultEntry = {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: {
        rawRequest: vi.fn().mockResolvedValue({ data: { issueLabel: labelNode() } })
      },
      createIssueLabel: vi.fn(),
      updateIssueLabel: vi.fn(),
      issueLabelRetire: vi.fn(),
      issueLabelRestore: vi.fn()
    }
  }
  const overrideClient = (overrides as { client?: Record<string, unknown> }).client
  return {
    ...defaultEntry,
    ...overrides,
    client: {
      ...defaultEntry.client,
      ...overrideClient,
      client: {
        ...defaultEntry.client.client,
        ...(overrideClient?.client as Record<string, unknown> | undefined)
      }
    }
  } as unknown as LinearClientForWorkspace
}

function labelNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'label-1',
    name: 'Bug',
    color: '#eb5757',
    description: 'Defects',
    isGroup: false,
    archivedAt: null,
    retiredAt: null,
    team: Promise.resolve({ id: 'team-1', name: 'Core' }),
    parent: Promise.resolve({ id: 'parent-1', name: 'Type' }),
    ...overrides
  }
}

describe('Linear label catalog API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthError.mockReturnValue(false)
    getStatus.mockReturnValue({ selectedWorkspaceId: 'workspace-1' })
    getClients.mockReturnValue([makeEntry()])
  })

  it('lists issue labels with workspace metadata and raw team/parent fields', async () => {
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        issueLabels: {
          nodes: [
            labelNode({
              team: { id: 'team-1', name: 'Core' },
              parent: { id: 'parent-1', name: 'Type' }
            })
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    })
    getClients.mockReturnValue([makeEntry({ client: { client: { rawRequest } } } as never)])
    const { listIssueLabels } = await import('./labels')

    await expect(
      listIssueLabels({ workspaceId: 'workspace-1', teamId: 'team-1' })
    ).resolves.toEqual([
      {
        id: 'label-1',
        name: 'Bug',
        color: '#eb5757',
        description: 'Defects',
        teamId: 'team-1',
        teamName: 'Core',
        parentId: 'parent-1',
        parentName: 'Type',
        isGroup: false,
        archivedAt: null,
        retiredAt: null,
        retired: false,
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace'
      }
    ])

    expect(getClients).toHaveBeenCalledWith('workspace-1')
    expect(rawRequest).toHaveBeenCalledWith(
      expect.stringContaining('query OrcaLinearIssueLabels'),
      {
        first: 100,
        includeArchived: false,
        filter: { team: { id: { eq: 'team-1' } } }
      }
    )
    expect(rawRequest.mock.calls[0][0]).toContain('archivedAt')
    expect(rawRequest.mock.calls[0][0]).toContain('retiredBy')
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('hides retired labels from the default catalog view', async () => {
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        issueLabels: {
          nodes: [
            labelNode({ id: 'active-label', name: 'Active', team: null, parent: null }),
            labelNode({
              id: 'retired-label',
              name: 'Retired',
              retiredBy: { id: 'user-1' },
              team: null,
              parent: null
            })
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    })
    getClients.mockReturnValue([makeEntry({ client: { client: { rawRequest } } } as never)])
    const { listIssueLabels } = await import('./labels')

    await expect(listIssueLabels({ workspaceId: 'workspace-1' })).resolves.toMatchObject([
      { id: 'active-label' }
    ])
  })

  it('includes retired labels when archived labels are requested', async () => {
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        issueLabels: {
          nodes: [
            labelNode({
              id: 'retired-label',
              retiredBy: { id: 'user-1' },
              team: null,
              parent: null
            })
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    })
    getClients.mockReturnValue([makeEntry({ client: { client: { rawRequest } } } as never)])
    const { listIssueLabels } = await import('./labels')

    await expect(
      listIssueLabels({ workspaceId: 'workspace-1', includeArchived: true })
    ).resolves.toMatchObject([{ id: 'retired-label', retired: true }])
  })

  it('follows label list pagination so large catalogs are complete', async () => {
    const rawRequest = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          issueLabels: {
            nodes: [labelNode({ id: 'label-1', name: 'Alpha', team: null, parent: null })],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          issueLabels: {
            nodes: [labelNode({ id: 'label-2', name: 'Beta', team: null, parent: null })],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      })
    getClients.mockReturnValue([makeEntry({ client: { client: { rawRequest } } } as never)])
    const { listIssueLabels } = await import('./labels')

    await expect(listIssueLabels({ workspaceId: 'workspace-1' })).resolves.toMatchObject([
      { id: 'label-1' },
      { id: 'label-2' }
    ])

    expect(rawRequest).toHaveBeenNthCalledWith(1, expect.any(String), {
      first: 100,
      includeArchived: false
    })
    expect(rawRequest).toHaveBeenNthCalledWith(2, expect.any(String), {
      first: 100,
      includeArchived: false,
      after: 'cursor-1'
    })
  })

  it('throws label list failures for a single selected workspace', async () => {
    const apiError = new Error('Linear unavailable')
    getClients.mockReturnValue([
      makeEntry({
        client: { client: { rawRequest: vi.fn().mockRejectedValue(apiError) } }
      } as never)
    ])
    const { listIssueLabels } = await import('./labels')

    await expect(listIssueLabels({ workspaceId: 'workspace-1' })).rejects.toThrow(
      'Linear unavailable'
    )
  })

  it('fans out label listing across selected workspaces and clears only the failed auth workspace', async () => {
    const authError = new Error('unauthorized')
    isAuthError.mockImplementation((error) => error === authError)
    const okEntry = makeEntry({
      workspace: {
        id: 'workspace-ok',
        organizationId: 'workspace-ok',
        organizationName: 'Ok workspace',
        displayName: 'Ada',
        email: 'ada@example.com'
      },
      client: {
        client: {
          rawRequest: vi.fn().mockResolvedValue({
            data: {
              issueLabels: {
                nodes: [labelNode({ id: 'label-ok', team: null, parent: null })],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          })
        }
      }
    } as never)
    const authEntry = makeEntry({
      workspace: {
        id: 'workspace-auth',
        organizationId: 'workspace-auth',
        organizationName: 'Auth workspace',
        displayName: 'Ada',
        email: 'ada@example.com'
      },
      client: { client: { rawRequest: vi.fn().mockRejectedValue(authError) } }
    } as never)
    getClients.mockReturnValue([authEntry, okEntry])
    const { listIssueLabels } = await import('./labels')

    await expect(listIssueLabels({ workspaceId: 'all' })).resolves.toMatchObject([
      { id: 'label-ok', workspaceId: 'workspace-ok' }
    ])

    expect(clearToken).toHaveBeenCalledWith('workspace-auth')
  })

  it('creates labels with explicit mutation envelopes and mapped label data', async () => {
    const createIssueLabel = vi.fn().mockResolvedValue({ success: true, issueLabel: labelNode() })
    getClients.mockReturnValue([makeEntry({ client: { createIssueLabel } } as never)])
    const { createIssueLabel: createLinearIssueLabel } = await import('./labels')

    await expect(
      createLinearIssueLabel(
        { name: 'Bug', color: '#eb5757', description: 'Defects', teamId: 'team-1' },
        'workspace-1'
      )
    ).resolves.toMatchObject({ ok: true, label: { id: 'label-1', workspaceId: 'workspace-1' } })

    expect(createIssueLabel).toHaveBeenCalledWith({
      name: 'Bug',
      color: '#eb5757',
      description: 'Defects',
      teamId: 'team-1'
    })
  })

  it('awaits SDK mutation label relations before hydrating success data', async () => {
    const createIssueLabel = vi.fn().mockResolvedValue({
      success: true,
      issueLabel: Promise.resolve(labelNode({ id: 'label-promised' }))
    })
    const rawRequest = vi.fn().mockResolvedValue({
      data: { issueLabel: labelNode({ id: 'label-promised', team: null, parent: null }) }
    })
    getClients.mockReturnValue([
      makeEntry({ client: { client: { rawRequest }, createIssueLabel } } as never)
    ])
    const { createIssueLabel: createLinearIssueLabel } = await import('./labels')

    await expect(createLinearIssueLabel({ name: 'Bug' }, 'workspace-1')).resolves.toMatchObject({
      ok: true,
      label: { id: 'label-promised' }
    })
    expect(rawRequest).toHaveBeenCalledWith(expect.stringContaining('query OrcaLinearIssueLabel'), {
      id: 'label-promised'
    })
  })

  it('updates labels and preserves nullable fields in the Linear payload', async () => {
    const updateIssueLabel = vi.fn().mockResolvedValue({ success: true, issueLabel: labelNode() })
    getClients.mockReturnValue([makeEntry({ client: { updateIssueLabel } } as never)])
    const { updateIssueLabel: updateLinearIssueLabel } = await import('./labels')

    await expect(
      updateLinearIssueLabel('label-1', { description: null, parentId: null }, 'workspace-1')
    ).resolves.toMatchObject({ ok: true, label: { id: 'label-1' } })

    expect(updateIssueLabel).toHaveBeenCalledWith('label-1', {
      description: null,
      parentId: null
    })
  })

  it('returns mutation errors without claiming success', async () => {
    const createIssueLabel = vi.fn().mockResolvedValue({ success: false, issueLabel: null })
    getClients.mockReturnValue([makeEntry({ client: { createIssueLabel } } as never)])
    const { createIssueLabel: createLinearIssueLabel } = await import('./labels')

    await expect(createLinearIssueLabel({ name: 'Bug' }, 'workspace-1')).resolves.toEqual({
      ok: false,
      error: 'Linear label create failed'
    })
  })

  it('clears tokens and rethrows auth failures during mutations', async () => {
    const authError = new Error('unauthorized')
    isAuthError.mockImplementation((error) => error === authError)
    const updateIssueLabel = vi.fn().mockRejectedValue(authError)
    getClients.mockReturnValue([makeEntry({ client: { updateIssueLabel } } as never)])
    const { updateIssueLabel: updateLinearIssueLabel } = await import('./labels')

    await expect(updateLinearIssueLabel('label-1', { name: 'Bug' }, 'workspace-1')).rejects.toThrow(
      'unauthorized'
    )
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
  })

  it('retires and restores labels through Linear SDK mutations', async () => {
    const issueLabelRetire = vi.fn().mockResolvedValue({ success: true, issueLabel: labelNode() })
    const issueLabelRestore = vi.fn().mockResolvedValue({ success: true, issueLabel: labelNode() })
    getClients.mockReturnValue([
      makeEntry({ client: { issueLabelRetire, issueLabelRestore } } as never)
    ])
    const { retireIssueLabel, restoreIssueLabel } = await import('./labels')

    await expect(retireIssueLabel('label-1', 'workspace-1')).resolves.toMatchObject({ ok: true })
    await expect(restoreIssueLabel('label-1', 'workspace-1')).resolves.toMatchObject({ ok: true })

    expect(issueLabelRetire).toHaveBeenCalledWith('label-1')
    expect(issueLabelRestore).toHaveBeenCalledWith('label-1')
  })

  it('hydrates mutation results so retire state is returned accurately', async () => {
    const archivedAt = '2026-05-30T12:00:00.000Z'
    const issueLabelRetire = vi.fn().mockResolvedValue({
      success: true,
      issueLabel: Promise.resolve({ id: 'label-1' })
    })
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        issueLabel: labelNode({
          id: 'label-1',
          archivedAt,
          retiredBy: { id: 'user-1' },
          team: null,
          parent: null
        })
      }
    })
    getClients.mockReturnValue([
      makeEntry({ client: { client: { rawRequest }, issueLabelRetire } } as never)
    ])
    const { retireIssueLabel } = await import('./labels')

    await expect(retireIssueLabel('label-1', 'workspace-1')).resolves.toMatchObject({
      ok: true,
      label: { id: 'label-1', archivedAt, retired: true }
    })
    expect(rawRequest).toHaveBeenCalledWith(expect.stringContaining('query OrcaLinearIssueLabel'), {
      id: 'label-1'
    })
    expect(rawRequest.mock.calls[0][0]).toContain('archivedAt')
    expect(rawRequest.mock.calls[0][0]).toContain('retiredBy')
  })

  it('rejects mutations when all workspaces are selected', async () => {
    const { createIssueLabel: createLinearIssueLabel } = await import('./labels')

    await expect(createLinearIssueLabel({ name: 'Bug' }, 'all')).resolves.toEqual({
      ok: false,
      error: 'Select a single Linear workspace before editing labels.'
    })
    expect(getClients).not.toHaveBeenCalled()
  })

  it('rejects mutations when the stored Linear selection is all and no workspace is passed', async () => {
    getStatus.mockReturnValue({ selectedWorkspaceId: 'all' })
    const { createIssueLabel: createLinearIssueLabel } = await import('./labels')

    await expect(createLinearIssueLabel({ name: 'Bug' })).resolves.toEqual({
      ok: false,
      error: 'Select a single Linear workspace before editing labels.'
    })
    expect(getClients).not.toHaveBeenCalled()
  })
})
