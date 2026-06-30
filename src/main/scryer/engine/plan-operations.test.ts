import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext, ScryerPlanPendingResult } from './types'

function testContext(projectPath: string, requestId = 'req-plan'): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

async function writeScryerFile(
  projectPath: string,
  fileName: string,
  model: unknown
): Promise<void> {
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(join(projectPath, '.scryer', fileName), JSON.stringify(model, null, 2), 'utf8')
}

describe('scryer plan operations', () => {
  it('reports pending changes between committed and planned state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-pending-'))
    await writeScryerFile(projectPath, 'model.scry', {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }
      ],
      links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await writeScryerFile(projectPath, 'planned.scry', {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        { id: 'api', kind: 'container', name: 'Public API', parentId: 'shop' },
        { id: 'worker', kind: 'container', name: 'Worker', parentId: 'shop' }
      ],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation<ScryerPlanPendingResult>(
      'scryer.plan.pending',
      {},
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.plan.pending',
      requestId: 'req-plan',
      result: {
        summary: {
          total: 4,
          toImplement: 1,
          toReimplement: 1,
          toDelete: 2
        }
      }
    })
    expect(result.ok && result.result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'node', id: 'api' }),
        expect.objectContaining({ kind: 'node', id: 'worker' }),
        expect.objectContaining({ kind: 'node', id: 'web' }),
        expect.objectContaining({ kind: 'link', id: 'link-web-api' })
      ])
    )
  })

  it('folds selected responsibility and link changes into committed state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-fold-'))
    await writeScryerFile(projectPath, 'model.scry', {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        {
          id: 'api',
          kind: 'container',
          name: 'API',
          parentId: 'shop',
          responsibilities: [{ id: 'resp-a', statement: 'serves old routes' }]
        },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }
      ],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await writeScryerFile(projectPath, 'planned.scry', {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        {
          id: 'api',
          kind: 'container',
          name: 'API',
          parentId: 'shop',
          responsibilities: [
            { id: 'resp-a', statement: 'serves old routes' },
            { id: 'resp-b', statement: 'serves public routes' },
            { id: 'resp-c', statement: 'serves admin routes' }
          ]
        },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }
      ],
      links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.plan.fold',
      {
        node_id: 'api',
        responsibility_ids: ['resp-b'],
        link_ids: ['link-web-api']
      },
      testContext(projectPath, 'req-fold')
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.plan.fold',
      requestId: 'req-fold',
      result: {
        folded: [
          { kind: 'responsibility', id: 'resp-b' },
          { kind: 'link', id: 'link-web-api' }
        ],
        remaining: [expect.objectContaining({ kind: 'responsibility', id: 'resp-c' })],
        findings: []
      }
    })

    const committed = JSON.parse(await readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8'))
    expect(committed.nodes[1].responsibilities.map((item: { id: string }) => item.id)).toEqual([
      'resp-a',
      'resp-b'
    ])
    expect(committed.links).toEqual([
      { id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }
    ])

    const baseline = JSON.parse(
      await readFile(join(projectPath, '.scryer', 'model.baseline.scry'), 'utf8')
    )
    expect(baseline).toEqual(committed)
    expect(await readFile(join(projectPath, '.scryer', 'history.jsonl'), 'utf8')).toContain(
      'scryer.plan.fold'
    )
  })
})
