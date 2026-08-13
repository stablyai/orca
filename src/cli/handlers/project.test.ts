import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_HANDLERS } from './project'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

describe('project group CLI handlers', () => {
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient
  let logSpy: ReturnType<typeof vi.spyOn>

  function run(command: string, flags: Record<string, string | boolean>): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(Object.entries(flags)),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs: []
    }
    return PROJECT_HANDLERS[command](ctx)
  }

  beforeEach(() => {
    callMock.mockReset()
    callMock.mockResolvedValue({ result: {} })
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('create calls projectGroup.create with name and parentPath', async () => {
    callMock.mockResolvedValue({
      result: { group: { id: 'grp-1', name: 'frontend', parentPath: null } }
    })
    await run('project group create', { name: 'frontend' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'frontend',
      parentPath: undefined
    })
  })

  it('create forwards --parent-path when provided', async () => {
    callMock.mockResolvedValue({
      result: { group: { id: 'grp-1', name: 'child', parentPath: '/tmp/umbrella' } }
    })
    await run('project group create', { name: 'child', 'parent-path': '/tmp/umbrella' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.create', {
      name: 'child',
      parentPath: '/tmp/umbrella'
    })
  })

  it('create rejects a missing name', async () => {
    await expect(run('project group create', {})).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('list calls projectGroup.list', async () => {
    callMock.mockResolvedValue({ result: { groups: [] } })
    await run('project group list', {})
    expect(callMock).toHaveBeenCalledWith('projectGroup.list')
  })

  it('add with --repo calls projectGroup.moveProject with the repo selector', async () => {
    callMock.mockResolvedValue({ result: { repo: { id: 'repo-1', projectGroupId: 'grp-1' } } })
    await run('project group add', { repo: 'web', group: 'grp-1' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.moveProject', {
      repo: 'web',
      groupId: 'grp-1'
    })
  })

  it('add with --project resolves the ready host setup to a repo selector', async () => {
    callMock.mockImplementation((method: string) => {
      if (method === 'projectHostSetup.list') {
        return Promise.resolve({
          result: {
            setups: [
              {
                id: 's1',
                projectId: 'github:x/y',
                hostId: 'local',
                setupState: 'ready',
                repoId: 'r9'
              }
            ]
          }
        })
      }
      return Promise.resolve({ result: { repo: { id: 'r9', projectGroupId: 'grp-1' } } })
    })
    await run('project group add', { project: 'github:x/y', group: 'grp-1' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.moveProject', {
      repo: 'id:r9',
      groupId: 'grp-1'
    })
  })

  it('add rejects when no project selector is given', async () => {
    await expect(run('project group add', { group: 'grp-1' })).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('add rejects --repo combined with --project', async () => {
    await expect(
      run('project group add', { repo: 'web', project: 'github:x/y', group: 'grp-1' })
    ).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rm calls projectGroup.delete with groupId', async () => {
    callMock.mockResolvedValue({ result: { deleted: true } })
    await run('project group rm', { group: 'grp-1' })
    expect(callMock).toHaveBeenCalledWith('projectGroup.delete', { groupId: 'grp-1' })
  })

  it('rm rejects a missing --group', async () => {
    await expect(run('project group rm', {})).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })
})
