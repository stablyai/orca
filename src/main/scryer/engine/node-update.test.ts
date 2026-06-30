import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function testContext(projectPath: string, requestId = 'req-node-update'): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

async function writeModel(projectPath: string, model: unknown): Promise<void> {
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(
    join(projectPath, '.scryer', 'model.scry'),
    JSON.stringify(model, null, 2),
    'utf8'
  )
}

describe('scryer.node.update', () => {
  it('writes node patches to planned state and leaves committed state unchanged', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-node-update-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [{ id: 'api', kind: 'system', name: 'API', responsibilities: [] }],
      links: [],
      groups: [],
      sourceMap: { api: [{ pattern: 'src/api.ts', line: 10, endLine: 20 }] },
      boundaries: { api: [{ pattern: 'src/api/**/*.ts', comment: 'API container sources' }] }
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.node.update',
      {
        nodes: [
          {
            node_id: 'api',
            name: 'Public API',
            notes: 'Runtime notes',
            responsibilities: [{ id: 'resp-1', statement: 'serves user requests' }]
          }
        ]
      },
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.node.update',
      requestId: 'req-node-update',
      result: {
        updatedCount: 1,
        pendingSummary: { total: 2 }
      }
    })

    const committed = JSON.parse(await readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8'))
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(committed.nodes[0].name).toBe('API')
    expect(committed.nodes[0].responsibilities).toEqual([])
    expect(planned.nodes[0].name).toBe('Public API')
    expect(planned.nodes[0].notes).toBe('Runtime notes')
    expect(planned.nodes[0].responsibilities).toEqual([
      { id: 'resp-1', statement: 'serves user requests' }
    ])
    expect(planned.sourceMap).toEqual({})
    expect(planned.boundaries).toEqual({})
  })

  it('returns lock_busy when another writer owns the model lock', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-node-lock-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [{ id: 'api', kind: 'system', name: 'API' }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await writeFile(join(projectPath, '.scryer', '.lock'), 'held', 'utf8')

    const result = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', name: 'Public API' }] },
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.node.update',
      requestId: 'req-node-update',
      error: {
        code: 'lock_busy',
        retryable: true
      }
    })
  })

  it('merges and clears node appearance patches', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-node-appearance-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [{ id: 'api', kind: 'system', name: 'API', appearance: { status: 'proposed' } }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const shaped = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', appearance: { shape: 'hexagon' } }] },
      testContext(projectPath, 'req-node-appearance-set')
    )
    expect(shaped).toMatchObject({ ok: true })
    const plannedWithShape = JSON.parse(
      await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8')
    )
    expect(plannedWithShape.nodes[0].appearance).toEqual({
      status: 'proposed',
      shape: 'hexagon'
    })

    const cleared = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', appearance: { shape: null } }] },
      testContext(projectPath, 'req-node-appearance-clear')
    )
    expect(cleared).toMatchObject({ ok: true })
    const plannedWithoutShape = JSON.parse(
      await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8')
    )
    expect(plannedWithoutShape.nodes[0].appearance).toEqual({ status: 'proposed' })
  })

  it('keeps appearance metadata when adding symbols', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-symbol-appearance-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [{ id: 'controller', kind: 'component', name: 'Controller' }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.symbol.add',
      {
        items: [
          {
            parent_id: 'controller',
            name: 'Task',
            appearance: { symbolKind: 'model' },
            properties: []
          }
        ]
      },
      testContext(projectPath, 'req-symbol-appearance')
    )

    expect(result).toMatchObject({ ok: true })
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'symbol',
        parentId: 'controller',
        name: 'Task',
        appearance: { symbolKind: 'model' },
        properties: []
      })
    )
  })

  it('rejects group.update re-parenting before writing planned state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-group-update-parent-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }
      ],
      links: [],
      groups: [
        { id: 'group-api', name: 'API group', memberIds: ['api'], parentNodeId: 'shop' },
        { id: 'group-web', name: 'Web group', memberIds: ['web'], parentNodeId: 'shop' }
      ],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.group.update',
      {
        items: [{ group_id: 'group-web', parent_group_id: 'group-api' }]
      },
      testContext(projectPath, 'req-group-update-parent')
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.group.update',
      requestId: 'req-group-update-parent',
      error: {
        code: 'invalid_input',
        retryable: false,
        fieldErrors: [
          {
            path: 'items[].parent_group_id',
            message: 'Re-parenting is not supported by group.update'
          }
        ]
      }
    })
    await expect(
      readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('deletes nodes with descendants, links, source ownership, and groups', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-node-delete-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
        { id: 'handler', kind: 'component', name: 'Handler', parentId: 'api' },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }
      ],
      links: [
        { id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' },
        { id: 'link-shop-web', src: 'shop', dst: 'web', label: 'uses' }
      ],
      groups: [
        { id: 'group-api', name: 'API group', memberIds: ['api', 'handler'], parentNodeId: 'shop' },
        { id: 'group-web', name: 'Web group', memberIds: ['web'], parentGroupId: 'group-api' }
      ],
      sourceMap: { api: [{ pattern: 'src/api.ts' }] },
      boundaries: { api: [{ pattern: 'src/**/*.ts' }] }
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.node.delete',
      { node_ids: ['api'] },
      testContext(projectPath, 'req-node-delete')
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.node.delete',
      requestId: 'req-node-delete',
      result: {
        deletedCount: 2,
        deletedLinkCount: 1
      }
    })

    const committed = JSON.parse(await readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8'))
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(committed.nodes.map((node: { id: string }) => node.id)).toEqual([
      'shop',
      'api',
      'handler',
      'web'
    ])
    expect(planned.nodes.map((node: { id: string }) => node.id)).toEqual(['shop', 'web'])
    expect(planned.links).toEqual([{ id: 'link-shop-web', src: 'shop', dst: 'web', label: 'uses' }])
    expect(planned.sourceMap).toEqual({})
    expect(planned.boundaries).toEqual({})
    expect(planned.groups).toEqual([{ id: 'group-web', name: 'Web group', memberIds: ['web'] }])
  })

  it('rejects missing node deletes before writing planned state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-node-delete-missing-'))
    await writeModel(projectPath, {
      version: '0.3',
      nodes: [{ id: 'shop', kind: 'system', name: 'Shop' }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.node.delete',
      { node_ids: ['missing-node'] },
      testContext(projectPath, 'req-node-delete-missing')
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.node.delete',
      requestId: 'req-node-delete-missing',
      error: {
        code: 'not_found',
        retryable: false
      }
    })
    await expect(readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8')).rejects.toThrow()
  })
})
