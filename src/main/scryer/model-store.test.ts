import { mkdir, mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  createGlobalModel,
  getProjectModelPath,
  getGlobalModelPath,
  createProjectModel,
  deleteProjectModel,
  listProjectModels,
  migrateGlobalModelToProject,
  markSynced,
  patchNodeData,
  readBaseline,
  readModel,
  readModelDocument,
  saveProjectModelAs,
  writeBaseline,
  writeModel,
  writeModelDocument
} from './model-store'

describe('project-local Scryer model store', () => {
  it('creates and round-trips .scryer/model.scry with a real project path', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-model-'))
    const model = await readModel(projectPath)

    expect(model).toMatchObject({
      nodes: [],
      edges: [],
      startingLevel: 'system',
      sourceMap: {},
      projectPath
    })
    expect(await readFile(getProjectModelPath(projectPath), 'utf8')).toContain('"nodes"')

    model.nodes.push({
      id: 'node-1',
      type: 'c4',
      position: { x: 10, y: 20 },
      data: {
        name: 'Web App',
        description: 'User interface',
        kind: 'container',
        status: 'proposed'
      }
    })
    await writeModel(projectPath, model)

    expect((await readModel(projectPath)).nodes[0].data.name).toBe('Web App')
  })

  it('writes baseline and sync timestamp files used by drift checks', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-baseline-'))
    const model = await readModel(projectPath)
    await writeBaseline(projectPath, model)
    await markSynced(projectPath)

    expect(await readBaseline(projectPath)).toMatchObject({ nodes: [], edges: [] })
    expect((await stat(join(projectPath, '.scryer', '.sync'))).isFile()).toBe(true)
  })

  it('rejects invalid model JSON instead of silently creating a fake graph', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-invalid-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(getProjectModelPath(projectPath), '{"nodes":')

    await expect(readModel(projectPath)).rejects.toThrow(/Invalid Scryer model JSON/)
  })

  it('creates, lists, saves as, and deletes project-local model files', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-model-list-'))

    await createProjectModel(projectPath, { modelName: 'roadmap' })
    let models = await listProjectModels(projectPath, { includeGlobal: false })
    expect(models.map((model) => model.name)).toEqual(['roadmap'])

    const roadmap = await readModel(projectPath, 'roadmap')
    roadmap.nodes.push({
      id: 'system',
      type: 'c4',
      data: { name: 'Roadmap', description: 'Planning system', kind: 'system' }
    })
    await writeModel(projectPath, roadmap, 'roadmap')

    await saveProjectModelAs(projectPath, 'roadmap', 'release-plan')
    expect((await readModel(projectPath, 'release-plan')).nodes[0].data.name).toBe('Roadmap')

    await deleteProjectModel(projectPath, 'roadmap')
    models = await listProjectModels(projectPath, { includeGlobal: false })
    expect(models.map((model) => model.name)).toEqual(['release-plan'])
  })

  it('tracks revisions and merges non-conflicting node field patches', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-revision-'))
    await writeModel(projectPath, {
      nodes: [
        {
          id: 'api',
          type: 'c4',
          data: { name: 'API', description: 'Initial description', kind: 'system' }
        }
      ],
      edges: [],
      sourceMap: {},
      groups: [],
      flows: []
    })
    const base = await readModelDocument(projectPath)
    const externallyEdited = {
      ...base.model,
      nodes: base.model.nodes.map((node) =>
        node.id === 'api'
          ? { ...node, data: { ...node.data, description: 'External editor description' } }
          : node
      )
    }
    await writeModelDocument(projectPath, externallyEdited)

    const patched = await patchNodeData(projectPath, {
      nodeId: 'api',
      patch: { name: 'API Local Draft' },
      baseRevision: base.revision,
      baseNodeData: base.model.nodes[0]!.data
    })

    expect(patched.revision).not.toBe(base.revision)
    expect(patched.model.nodes[0].data).toMatchObject({
      name: 'API Local Draft',
      description: 'External editor description'
    })
  })

  it('rejects a stale node field patch when the same field changed on disk', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-revision-conflict-'))
    await writeModel(projectPath, {
      nodes: [
        {
          id: 'api',
          type: 'c4',
          data: { name: 'API', description: 'Initial description', kind: 'system' }
        }
      ],
      edges: [],
      sourceMap: {},
      groups: [],
      flows: []
    })
    const base = await readModelDocument(projectPath)
    await patchNodeData(projectPath, {
      nodeId: 'api',
      patch: { name: 'External API' },
      baseRevision: base.revision,
      baseNodeData: base.model.nodes[0]!.data
    })

    await expect(
      patchNodeData(projectPath, {
        nodeId: 'api',
        patch: { name: 'API Local Draft' },
        baseRevision: base.revision,
        baseNodeData: base.model.nodes[0]!.data
      })
    ).rejects.toThrow(/changed on disk/)
  })

  it('loads built-in templates into project-local model files', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-template-'))

    const model = await createProjectModel(projectPath, {
      modelName: 'game-template',
      templateId: 'game'
    })

    expect(model.nodes.length).toBeGreaterThan(0)
    expect(model.nodes.some((node) => node.data.name === 'Game')).toBe(true)
    expect(
      (await readFile(getProjectModelPath(projectPath, 'game-template'), 'utf8')).length
    ).toBeGreaterThan(100)
  })

  it('lists global models and migrates them into the project model folder', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-global-project-'))
    const homePath = await mkdtemp(join(tmpdir(), 'orca-scryer-global-home-'))

    const global = await createGlobalModel(homePath, { modelName: 'shared-platform' })
    global.nodes.push({
      id: 'system',
      type: 'c4',
      data: { name: 'Shared Platform', description: 'Global model', kind: 'system' }
    })
    await createGlobalModel(homePath, { modelName: 'shared-platform', model: global })

    const models = await listProjectModels(projectPath, { globalHomePath: homePath })
    expect(models.map((model) => `${model.scope}:${model.name}`)).toEqual([
      'global:shared-platform'
    ])

    const migrated = await migrateGlobalModelToProject(projectPath, 'shared-platform', {
      globalHomePath: homePath
    })
    expect(migrated.model.nodes[0].data.name).toBe('Shared Platform')
    expect(await readFile(getProjectModelPath(projectPath, 'shared-platform'), 'utf8')).toContain(
      'Shared Platform'
    )
    expect(await readFile(getGlobalModelPath('shared-platform', homePath), 'utf8')).toContain(
      'Shared Platform'
    )
  })
})
