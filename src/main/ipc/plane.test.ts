import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args?: unknown) => unknown

const { handlers, operations, clientModule } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  operations: {
    planeAddComment: vi.fn(),
    planeCreateWorkItem: vi.fn(),
    planeGetWorkItem: vi.fn(),
    planeListLabels: vi.fn(),
    planeListMembers: vi.fn(),
    planeListProjects: vi.fn(),
    planeListStates: vi.fn(),
    planeListWorkItems: vi.fn(),
    planeSearchWorkItems: vi.fn(),
    planeUpdateWorkItem: vi.fn(),
    planeWorkItemComments: vi.fn()
  },
  clientModule: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(),
    selectWorkspace: vi.fn(),
    testConnection: vi.fn()
  }
}))

async function registerHandlers() {
  vi.resetModules()
  handlers.clear()
  vi.doMock('electron', () => ({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      }
    }
  }))
  vi.doMock('../plane/provider-operations', () => operations)
  vi.doMock('../plane/client', () => clientModule)
  const { registerPlaneHandlers } = await import('./plane')
  registerPlaneHandlers()
}

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }
  return handler({}, args)
}

const project = { id: 'p-1', identifier: 'PROJ', name: 'Platform' }

beforeEach(async () => {
  for (const mock of [...Object.values(operations), ...Object.values(clientModule)]) {
    mock.mockReset()
    mock.mockResolvedValue(undefined)
  }
  await registerHandlers()
})

describe('project normalization', () => {
  it('upper-cases the identifier and names an unnamed project after it', async () => {
    await invoke('plane:listWorkItems', { project: { id: ' p-1 ', identifier: ' proj ' } })
    expect(operations.planeListWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ project: { id: 'p-1', identifier: 'PROJ', name: 'PROJ' } })
    )
  })

  it.each([
    ['plane:listWorkItems', 'list Plane work items'],
    ['plane:workItemComments', 'read Plane comments'],
    ['plane:updateWorkItem', 'update a Plane work item'],
    ['plane:addComment', 'comment on a Plane work item'],
    ['plane:createWorkItem', 'create a Plane work item']
  ])('%s explains what it needs when the project is missing', async (channel, action) => {
    await expect(invoke(channel, {})).rejects.toThrow(`A project is required to ${action}.`)
  })

  it('lets getWorkItem run without a project, since it resolves one itself', async () => {
    await invoke('plane:getWorkItem', { key: 'PROJ-1' })
    expect(operations.planeGetWorkItem).toHaveBeenCalledWith({
      key: 'PROJ-1',
      workspaceId: undefined
    })
  })
})

describe('required id validation', () => {
  it.each([
    ['plane:listStates', {}, 'A project is required to list Plane states.'],
    ['plane:listLabels', {}, 'A project is required to list Plane labels.'],
    ['plane:workItemComments', { project }, 'A work item id is required to read Plane comments.'],
    [
      'plane:updateWorkItem',
      { project },
      'A work item id is required to update a Plane work item.'
    ],
    ['plane:addComment', { project }, 'A work item id is required to comment on a Plane work item.']
  ])(
    '%s names what is missing rather than building a malformed url',
    async (channel, args, message) => {
      await expect(invoke(channel, args)).rejects.toThrow(message)
    }
  )

  it('trims a padded id instead of rejecting it', async () => {
    await invoke('plane:listStates', { projectId: '  p-1  ' })
    expect(operations.planeListStates).toHaveBeenCalledWith('p-1', undefined)
  })
})

describe('work item update normalization', () => {
  it('distinguishes clearing a set from leaving it untouched', async () => {
    await invoke('plane:updateWorkItem', {
      project,
      workItemId: 'wi-1',
      updates: { assigneeIds: null, labelIds: ['l-1', '', ' l-2 '] }
    })
    const { updates } = operations.planeUpdateWorkItem.mock.calls[0]?.[0] ?? {}
    expect(updates).toEqual({ assigneeIds: null, labelIds: ['l-1', 'l-2'] })
    expect('title' in updates).toBe(false)
  })

  it('drops an unrecognised priority rather than forwarding it', async () => {
    await invoke('plane:updateWorkItem', {
      project,
      workItemId: 'wi-1',
      updates: { priority: 'critical', stateId: ' s-1 ' }
    })
    expect(operations.planeUpdateWorkItem.mock.calls[0]?.[0].updates).toEqual({ stateId: 's-1' })
  })

  it('accepts a null target date as a clear', async () => {
    await invoke('plane:updateWorkItem', {
      project,
      workItemId: 'wi-1',
      updates: { targetDate: null }
    })
    expect(operations.planeUpdateWorkItem.mock.calls[0]?.[0].updates).toEqual({ targetDate: null })
  })
})

describe('limit clamping', () => {
  it.each([
    [undefined, 20],
    [0, 1],
    [500, 100],
    [7, 7]
  ])('clamps a search limit of %s to %s', async (limit, expected) => {
    await invoke('plane:searchWorkItems', { search: 'x', limit })
    expect(operations.planeSearchWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expected })
    )
  })

  it('allows a larger list page than a search page', async () => {
    await invoke('plane:listWorkItems', { project, limit: 250 })
    expect(operations.planeListWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 250 })
    )
  })
})

describe('search cancellation', () => {
  it('ignores a cancel for a request that already settled', async () => {
    let observed: AbortSignal | undefined
    operations.planeSearchWorkItems.mockImplementation(async (args: { signal?: AbortSignal }) => {
      observed = args.signal
      return []
    })
    await invoke('plane:searchWorkItems', { search: 'a', requestId: 'req-1' })
    expect(observed?.aborted).toBe(false)

    const first = observed
    invoke('plane:cancelSearchWorkItems', { requestId: 'req-1' })
    // The earlier controller is resolved and dropped once its task settles, so a
    // cancel after completion is a no-op rather than an error.
    expect(first?.aborted).toBe(false)
  })

  it('cancels an in-flight search when the renderer abandons it', async () => {
    let observed: AbortSignal | undefined
    operations.planeSearchWorkItems.mockImplementation(
      async (args: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observed = args.signal
          args.signal?.addEventListener('abort', () => resolve([]), { once: true })
        })
    )
    const pending = invoke('plane:searchWorkItems', { search: 'a', requestId: 'req-1' })
    await vi.waitFor(() => expect(observed).toBeDefined())
    invoke('plane:cancelSearchWorkItems', { requestId: 'req-1' })
    await pending
    expect(observed?.aborted).toBe(true)
  })
})

describe('connection channels', () => {
  it('forwards connect args untouched and normalizes a blank workspace id away', async () => {
    await invoke('plane:connect', { baseUrl: 'x', workspaceSlug: 'y', apiToken: 'z' })
    expect(clientModule.connect).toHaveBeenCalledWith({
      baseUrl: 'x',
      workspaceSlug: 'y',
      apiToken: 'z'
    })
    await invoke('plane:disconnect', { workspaceId: '   ' })
    expect(clientModule.disconnect).toHaveBeenCalledWith(undefined)
  })

  it('reports a successful disconnect', async () => {
    await expect(invoke('plane:disconnect')).resolves.toEqual({ ok: true })
  })
})
