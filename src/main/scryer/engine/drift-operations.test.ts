import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTimeout } from 'timers/promises'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function testContext(projectPath: string, requestId = 'req-drift'): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

describe('scryer drift operations', () => {
  it('reports changed files covered by strict Scryer source boundaries', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-drift-'))
    await mkdir(join(projectPath, 'src'), { recursive: true })
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(join(projectPath, 'src', 'index.ts'), 'export const before = 1\n')
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'shop', kind: 'system', name: 'Shop' },
            { id: 'api', kind: 'container', name: 'API Container', parentId: 'shop' }
          ],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: { api: [{ pattern: 'src/**/*.ts' }] }
        },
        null,
        2
      ),
      'utf8'
    )

    await createScryerEngine().executeOperation(
      'scryer.drift.reconcile',
      {},
      testContext(projectPath, 'req-drift-reconcile')
    )
    await setTimeout(20)
    await writeFile(join(projectPath, 'src', 'index.ts'), 'export const after = 2\n')

    const result = await createScryerEngine().executeOperation(
      'scryer.drift.get',
      {},
      testContext(projectPath, 'req-drift-get')
    )

    expect(
      JSON.parse(await readFile(join(projectPath, '.scryer', '.sync.json'), 'utf8'))
    ).toHaveProperty('reconciledAt')
    expect(result).toMatchObject({
      ok: true,
      result: {
        clean: false,
        scopes: [{ nodeId: 'api', nodeName: 'API Container', path: 'src/**/*.ts' }]
      }
    })
  })
})
