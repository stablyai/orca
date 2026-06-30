import { mkdir, mkdtemp, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { setTimeout } from 'timers/promises'
import { describe, expect, it } from 'vitest'
import { checkDrift } from './drift'
import { markSynced, readModel, writeModel } from './model-store'

describe('checkDrift', () => {
  it('reports source-mapped nodes and project structure changes after sync', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-drift-'))
    await mkdir(join(projectPath, 'src'), { recursive: true })
    await writeFile(join(projectPath, 'src', 'api.ts'), 'export const before = 1\n')

    const model = await readModel(projectPath)
    model.nodes.push({
      id: 'api',
      type: 'c4',
      position: { x: 0, y: 0 },
      data: {
        name: 'API',
        description: 'Backend API',
        kind: 'container',
        status: 'implemented'
      }
    })
    model.sourceMap = {
      api: [{ pattern: 'src/**/*.ts', line: 1 }]
    }
    await writeModel(projectPath, model)
    await markSynced(projectPath)

    const syncMtime = (await stat(join(projectPath, '.scryer', '.sync'))).mtime
    await setTimeout(20)
    await writeFile(join(projectPath, 'src', 'api.ts'), 'export const after = 2\n')
    await writeFile(join(projectPath, 'src', 'new-module.ts'), 'export const fresh = true\n')

    const report = await checkDrift(projectPath)

    expect(syncMtime.getTime()).toBeLessThanOrEqual(Date.now())
    expect(report.nodes).toEqual([{ nodeId: 'api', nodeName: 'API', patterns: ['src/**/*.ts'] }])
    expect(report.structureChanged).toBe(true)
  })
})
