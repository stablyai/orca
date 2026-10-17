import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'repo',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  externalWorktreeVisibility: 'hide',
  projectGroupId: GROUP.id,
  projectGroupOrder: 3
}

function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-project-group-rpc-'))
  const runtime = new OrcaRuntimeService(null)
  const methods = {
    create: vi.spyOn(runtime, 'createProjectGroup').mockResolvedValue(GROUP),
    update: vi.spyOn(runtime, 'updateProjectGroup').mockResolvedValue(GROUP),
    delete: vi.spyOn(runtime, 'deleteProjectGroup').mockResolvedValue({ deleted: true }),
    move: vi.spyOn(runtime, 'moveProjectToGroup').mockResolvedValue(REPO),
    scan: vi.spyOn(runtime, 'scanNestedRepos'),
    import: vi.spyOn(runtime, 'importNestedRepos')
  }
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const device = server['deviceRegistry']!.addDevice('phone', 'mobile')
  return { server, token: device.token, methods }
}

async function dispatch(
  server: OrcaRuntimeRpcServer,
  token: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const replies: unknown[] = []
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: `request-${method}`, method, deviceToken: token, params }),
    (response) => replies.push(JSON.parse(response)),
    () => {}
  )
  return replies[0]
}

describe('paired mobile project-group management', () => {
  it('allows the explicit metadata-management set, including grouping and ungrouping repos', async () => {
    const { server, token, methods } = setup()

    const replies = await Promise.all([
      dispatch(server, token, 'projectGroup.create', { name: 'Platform' }),
      dispatch(server, token, 'projectGroup.update', {
        groupId: GROUP.id,
        updates: { name: 'Core', isCollapsed: true }
      }),
      dispatch(server, token, 'projectGroup.delete', { groupId: GROUP.id }),
      dispatch(server, token, 'projectGroup.moveProject', {
        repo: REPO.id,
        groupId: GROUP.id,
        order: 3
      }),
      dispatch(server, token, 'projectGroup.moveProject', {
        repo: REPO.id,
        groupId: null
      })
    ])

    expect(replies).toHaveLength(5)
    for (const reply of replies) {
      expect(reply).toMatchObject({ ok: true })
    }
    expect(methods.create).toHaveBeenCalledWith({ name: 'Platform' })
    expect(methods.update).toHaveBeenCalledWith(GROUP.id, {
      name: 'Core',
      isCollapsed: true
    })
    expect(methods.delete).toHaveBeenCalledWith(GROUP.id)
    expect(methods.move).toHaveBeenNthCalledWith(1, REPO.id, GROUP.id, 3)
    expect(methods.move).toHaveBeenNthCalledWith(2, REPO.id, null, undefined)
  })

  it('preserves project-group input validation before handlers run', async () => {
    const { server, token, methods } = setup()

    const invalidCreate = await dispatch(server, token, 'projectGroup.create', { name: '' })
    const invalidMove = await dispatch(server, token, 'projectGroup.moveProject', {
      repo: '',
      groupId: null
    })

    expect(invalidCreate).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Missing group name' }
    })
    expect(invalidMove).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Missing repo selector' }
    })
    expect(methods.create).not.toHaveBeenCalled()
    expect(methods.move).not.toHaveBeenCalled()
  })

  it('does not expose nested host-filesystem discovery and import', async () => {
    const { server, token, methods } = setup()

    const scan = await dispatch(server, token, 'projectGroup.scanNested', {
      path: '/srv/projects'
    })
    const importNested = await dispatch(server, token, 'projectGroup.importNested', {
      parentPath: '/srv/projects',
      groupName: 'Platform',
      projectPaths: ['/srv/projects/repo'],
      mode: 'group'
    })

    expect(scan).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(importNested).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(methods.scan).not.toHaveBeenCalled()
    expect(methods.import).not.toHaveBeenCalled()
  })
})
