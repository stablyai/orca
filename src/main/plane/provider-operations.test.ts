import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clientModule, metadata, reads, apiModule } = vi.hoisted(() => ({
  clientModule: { getClients: vi.fn(), getStatus: vi.fn(), clearToken: vi.fn() },
  metadata: {
    listProjects: vi.fn(),
    listStates: vi.fn(),
    listLabels: vi.fn(),
    listWorkspaceMembers: vi.fn()
  },
  reads: {
    getWorkItemByKey: vi.fn(),
    listComments: vi.fn(),
    listWorkItems: vi.fn(),
    searchWorkItems: vi.fn()
  },
  apiModule: { isPlaneAuthError: vi.fn() }
}))

const workspaceA = { id: 'ws-a', slug: 'a', name: 'a', baseUrl: 'https://x', appUrl: 'https://x' }
const workspaceB = { id: 'ws-b', slug: 'b', name: 'b', baseUrl: 'https://x', appUrl: 'https://x' }

async function loadOperations() {
  vi.resetModules()
  vi.doMock('./client', () => clientModule)
  vi.doMock('./project-metadata', () => metadata)
  vi.doMock('./work-items', () => reads)
  vi.doMock('./work-item-write', () => ({
    addComment: vi.fn(),
    createWorkItem: vi.fn(),
    updateWorkItem: vi.fn()
  }))
  vi.doMock('./authenticated-request', () => apiModule)
  return import('./provider-operations')
}

beforeEach(() => {
  for (const mock of [
    ...Object.values(clientModule),
    ...Object.values(metadata),
    ...Object.values(reads),
    ...Object.values(apiModule)
  ]) {
    mock.mockReset()
  }
  clientModule.getStatus.mockReturnValue({ activeWorkspaceId: 'ws-a' })
  clientModule.getClients.mockReturnValue([{ workspace: workspaceA, apiToken: 't' }])
  metadata.listProjects.mockResolvedValue([])
  apiModule.isPlaneAuthError.mockReturnValue(false)
})

describe('workspace resolution', () => {
  it('resolves an absent selection to the active workspace, not the stored order', async () => {
    // Regression: getClients returns workspaces ordered by most-recent-connect,
    // so taking [0] under an 'all' selection read from a different workspace
    // than getStatus() reported as active.
    const operations = await loadOperations()
    await operations.planeListProjects()
    expect(clientModule.getClients).toHaveBeenCalledWith('ws-a')
  })

  it("resolves an explicit 'all' the same way", async () => {
    const operations = await loadOperations()
    await operations.planeListProjects('all')
    expect(clientModule.getClients).toHaveBeenCalledWith('ws-a')
  })

  it('honours an explicit workspace id', async () => {
    const operations = await loadOperations()
    await operations.planeListProjects('ws-b')
    expect(clientModule.getClients).toHaveBeenCalledWith('ws-b')
  })

  it('explains that nothing is connected rather than throwing a type error', async () => {
    clientModule.getClients.mockReturnValue([])
    const operations = await loadOperations()
    await expect(operations.planeListProjects()).rejects.toThrow('Not connected to Plane.')
  })
})

describe('credential invalidation', () => {
  it('drops the stored token when Plane rejects it', async () => {
    // Regression: a revoked personal access token left its file in place, so
    // getStatus kept reporting connected while every read failed.
    clientModule.getClients.mockReturnValue([{ workspace: workspaceB, apiToken: 't' }])
    metadata.listProjects.mockRejectedValue(new Error('Invalid API key'))
    apiModule.isPlaneAuthError.mockReturnValue(true)
    const operations = await loadOperations()

    await expect(operations.planeListProjects('ws-b')).rejects.toThrow('Invalid API key')
    expect(clientModule.clearToken).toHaveBeenCalledWith('ws-b')
  })

  it('keeps the token for a permission or transport failure', async () => {
    metadata.listProjects.mockRejectedValue(new Error('Forbidden'))
    apiModule.isPlaneAuthError.mockReturnValue(false)
    const operations = await loadOperations()

    await expect(operations.planeListProjects()).rejects.toThrow('Forbidden')
    expect(clientModule.clearToken).not.toHaveBeenCalled()
  })

  it('applies to reads and writes alike', async () => {
    reads.searchWorkItems.mockRejectedValue(new Error('Invalid API key'))
    apiModule.isPlaneAuthError.mockReturnValue(true)
    const operations = await loadOperations()

    await expect(operations.planeSearchWorkItems({ search: 'x' })).rejects.toThrow()
    expect(clientModule.clearToken).toHaveBeenCalledWith('ws-a')
  })
})
