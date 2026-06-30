import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { readModel, writeModel } from './model-store'
import { beginSync, cancelSync, finishSync } from './sync'

describe('architecture sync lifecycle', () => {
  it('creates a real pre-sync snapshot, builds a drift prompt, and restores the model on cancel', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-sync-'))
    await mkdir(join(projectPath, 'src'), { recursive: true })
    await writeFile(join(projectPath, 'src', 'index.ts'), 'export const v = 1\n')
    await writeModel(projectPath, {
      nodes: [
        {
          id: 'system',
          type: 'c4',
          data: { name: 'Shop', description: 'Commerce', kind: 'system' }
        },
        {
          id: 'api',
          parentId: 'system',
          type: 'c4',
          data: { name: 'API', description: 'HTTP API', kind: 'container', status: 'implemented' }
        }
      ],
      edges: [],
      sourceMap: { api: [{ pattern: 'src/**/*.ts' }] },
      projectPath
    })

    await beginSync(projectPath, { modelName: 'Architecture' })
    const model = await readModel(projectPath)
    model.nodes[1]!.data.name = 'Broken During Sync'
    await writeModel(projectPath, model)

    const restored = await cancelSync(projectPath)
    expect(restored.nodes.find((node) => node.id === 'api')?.data.name).toBe('API')

    const prompt = (await beginSync(projectPath, { modelName: 'Architecture' })).prompt
    expect(prompt).toContain('architecture model "Architecture"')
    expect(prompt).toContain('"api"')
    expect(prompt).toContain('src/**/*.ts')
    expect(prompt).not.toContain('"position"')
    expect(prompt).not.toContain('"refPositions"')
  })

  it('clears implementing state and updates sync marker when sync finishes', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-sync-finish-'))
    await writeModel(projectPath, {
      nodes: [],
      edges: [],
      sourceMap: {},
      projectPath
    })

    await beginSync(projectPath, { modelName: 'Architecture' })
    await finishSync(projectPath)

    await expect(readFile(join(projectPath, '.scryer', '.implementing'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(projectPath, '.scryer', '.sync'), 'utf8')).resolves.toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
  })
})
