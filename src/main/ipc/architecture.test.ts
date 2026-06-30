import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ArchitectureWatchCallback = (eventType: string, filename: string) => void

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, watchMock, watchCallbacks } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  watchMock: vi.fn(),
  watchCallbacks: [] as ArchitectureWatchCallback[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    watch: watchMock
  }
})

import {
  changedScryerModelFileForOperation,
  closeArchitectureWatchers,
  defaultArchitectureDeps,
  registerArchitectureHandlers,
  shouldNotifyModelFile,
  type ArchitectureIpcRegistrar
} from './architecture'

describe('registerArchitectureHandlers', () => {
  afterEach(() => {
    closeArchitectureWatchers()
  })

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    watchCallbacks.length = 0
    watchMock.mockReset()
    watchMock.mockImplementation(
      (
        _filename: string,
        _options: unknown,
        listener: (eventType: string, filename: string) => void
      ) => {
        watchCallbacks.push(listener)
        return { close: vi.fn(), on: vi.fn() }
      }
    )
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })
    registerArchitectureHandlers()
  })

  it('bridges model read/write and MCP-style tool calls through IPC', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )
    const model = await handlers.get('architecture:readModel')!(null, { projectPath })
    expect(model).toMatchObject({ nodes: [], edges: [], projectPath })
    const document = await handlers.get('architecture:readModelDocument')!(null, { projectPath })
    expect(document).toMatchObject({
      model: { nodes: [], edges: [], projectPath },
      revision: expect.stringContaining('ipc-read-document')
    })

    const toolResult = await handlers.get('architecture:callTool')!(null, {
      projectPath,
      call: {
        toolName: 'set_model',
        arguments: {
          data: JSON.stringify({
            version: '0.3',
            nodes: [
              {
                id: 'system',
                kind: 'system',
                name: 'System',
                description: 'Root system'
              }
            ],
            links: [],
            groups: [],
            sourceMap: {},
            boundaries: {}
          })
        }
      }
    })
    expect(toolResult).toMatchObject({ ok: true })
  })

  it('reads renderer architecture views as Scryer 0.3 DTO envelopes', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-view-dto-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [
          { id: 'api', kind: 'system', name: 'API', description: 'HTTP API' },
          { id: 'web', kind: 'system', name: 'Web', technology: 'React' }
        ],
        links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
        groups: [{ id: 'frontend', name: 'Frontend', memberIds: ['web'] }],
        sourceMap: { web: [{ pattern: 'src/web.ts' }] },
        boundaries: { api: [{ pattern: 'src/api/**' }] }
      }),
      'utf8'
    )

    const result = await handlers.get('architecture:readArchitectureView')!(null, {
      projectPath,
      layer: 'committed',
      focusNodeId: 'web'
    })

    expect(result).toMatchObject({
      ok: true,
      operationId: 'architecture.readArchitectureView',
      result: {
        version: '0.3',
        layer: 'committed',
        nodes: [
          expect.objectContaining({ id: 'api', kind: 'system', name: 'API' }),
          expect.objectContaining({
            id: 'web',
            kind: 'system',
            technology: 'React'
          })
        ],
        links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
        groups: [expect.objectContaining({ id: 'frontend', memberIds: ['web'] })],
        sourceMap: { web: [{ pattern: 'src/web.ts' }] },
        boundaries: { api: [{ pattern: 'src/api/**' }] },
        treeRows: [
          expect.objectContaining({ id: 'api', path: 'API', depth: 0, childCount: 0 }),
          expect.objectContaining({ id: 'web', path: 'Web', depth: 0, childCount: 0 })
        ],
        sourceMapRows: [{ ownerId: 'web', locations: [{ pattern: 'src/web.ts' }] }],
        boundaryRows: [{ nodeId: 'api', sources: [{ pattern: 'src/api/**' }] }],
        driftIndicators: [],
        diagnostics: [],
        recommendedNextReads: expect.any(Array),
        selectedDetails: {
          node: expect.objectContaining({ id: 'web', name: 'Web' }),
          sourceLocations: [{ pattern: 'src/web.ts' }],
          boundarySources: [],
          outgoingLinks: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
          incomingLinks: [],
          groups: [expect.objectContaining({ id: 'frontend', memberIds: ['web'] })]
        },
        summary: { nodeCount: 2, linkCount: 1, groupCount: 1 },
        refresh: { strategy: 'focus', focusNodeId: 'web' }
      }
    })
    expect(result).not.toMatchObject({ result: { edges: expect.anything() } })
    expect(result).not.toMatchObject({ result: { flows: expect.anything() } })
  })

  it('returns strict schema failures through architecture view envelopes', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-view-strict-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [{ id: 'api', kind: 'system', name: 'API', data: {} }],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {},
        flows: []
      }),
      'utf8'
    )

    const result = await handlers.get('architecture:readArchitectureView')!(null, { projectPath })

    expect(result).toMatchObject({
      ok: false,
      operationId: 'architecture.readArchitectureView',
      error: {
        code: 'incompatible_model',
        details: {
          reason: 'unknown_fields',
          fields: ['nodes[0].data', 'flows']
        },
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({ path: 'nodes[0].data' }),
          expect.objectContaining({ path: 'flows' })
        ])
      }
    })
  })

  it('reads planned architecture view after starting authoring from an empty project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-empty-plan-'))
    const send = vi.fn()

    const writeResult = await handlers.get('architecture:executeScryerOperation')!(
      { sender: { send } },
      {
        projectPath,
        operationId: 'scryer.system.add',
        requestId: 'ipc-empty-system-add',
        input: { items: [{ name: 'System 1', description: '' }] }
      }
    )
    const viewResult = await handlers.get('architecture:readArchitectureView')!(null, {
      projectPath,
      layer: 'plan'
    })

    expect(writeResult).toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
    expect(viewResult).toMatchObject({
      ok: true,
      result: {
        layer: 'plan',
        nodes: [expect.objectContaining({ kind: 'system', name: 'System 1' })],
        summary: expect.objectContaining({ nodeCount: 1 })
      }
    })
    await expect(readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8')).rejects.toThrow()
  })

  it('does not create a legacy default model while refreshing planned node patches', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-planned-patch-'))
    const send = vi.fn()

    const writeResult = await handlers.get('architecture:executeScryerOperation')!(
      { sender: { send } },
      {
        projectPath,
        operationId: 'scryer.system.add',
        requestId: 'ipc-planned-system-add',
        input: { items: [{ name: 'System 1', description: '' }] }
      }
    )
    expect(writeResult).toMatchObject({ ok: true })

    const plannedBefore = JSON.parse(
      await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8')
    ) as { nodes: { id: string; name?: string }[] }
    const nodeId = plannedBefore.nodes[0]?.id
    expect(nodeId).toBeTruthy()

    const patched = await handlers.get('architecture:patchNodeData')!(
      { sender: { send } },
      { projectPath, modelName: 'model', nodeId, patch: { name: 'Shop System' } }
    )

    expect(patched).toMatchObject({
      model: {
        nodes: [
          expect.objectContaining({
            id: nodeId,
            data: expect.objectContaining({ name: 'Shop System' })
          })
        ]
      }
    })
    await expect(readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8')).rejects.toThrow()
  })

  it('creates the default blank model through the Scryer operation catalog', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-default-create-'))
    const send = vi.fn()
    const createProjectModel = vi.fn(defaultArchitectureDeps.createProjectModel)
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      createProjectModel
    })

    const result = await handlers.get('architecture:createModel')!(
      { sender: { send } },
      { projectPath, modelName: 'model' }
    )

    expect(result).toMatchObject({
      modelName: 'model',
      model: { nodes: [], edges: [] },
      revision: expect.stringContaining('ipc-model-set')
    })
    expect(createProjectModel).not.toHaveBeenCalled()
    await expect(
      readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({
      version: '0.3',
      nodes: [],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'model.scry'
    })
  })

  it('rejects legacy C4-shaped default raw writes instead of converting them', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-write-engine-'))

    await expect(
      handlers.get('architecture:writeModel')!(null, {
        projectPath,
        model: {
          nodes: [
            {
              id: 'system',
              type: 'c4',
              data: { name: 'Shop', description: 'Commerce', kind: 'system' }
            }
          ],
          edges: [],
          sourceMap: {}
        }
      })
    ).rejects.toThrow()
    await expect(readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8')).rejects.toThrow()
  })

  it('routes drift and reconcile IPC channels through Native Scryer Engine envelopes', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-drift-engine-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [
          { id: 'api', kind: 'system', name: 'API' },
          { id: 'worker', kind: 'container', name: 'Worker', parentId: 'api' },
          { id: 'web', kind: 'container', name: 'Web', parentId: 'api' }
        ],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )

    const drift = await handlers.get('architecture:checkDrift')!(null, { projectPath })
    expect(drift).toMatchObject({
      nodes: [],
      structureChanged: false
    })

    const reconciled = await handlers.get('architecture:markSynced')!(null, { projectPath })
    expect(reconciled).toMatchObject({
      ok: true,
      operationId: 'scryer.drift.reconcile',
      result: { reconciledAt: expect.any(String) }
    })
  })

  it('maps Scryer write operations to the file changed for renderer reloads', () => {
    expect(changedScryerModelFileForOperation('scryer.system.add')).toBe('planned.scry')
    expect(changedScryerModelFileForOperation('scryer.source.update')).toBe('planned.scry')
    expect(changedScryerModelFileForOperation('scryer.model.set')).toBe('model.scry')
    expect(changedScryerModelFileForOperation('scryer.plan.fold')).toBe('model.scry')
  })

  it('notifies the renderer immediately when IPC writes replace the model', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-write-'))
    const send = vi.fn()

    await handlers.get('architecture:writeModel')!(
      { sender: { send } },
      {
        projectPath,
        model: {
          version: '0.3',
          nodes: [
            {
              id: 'system',
              kind: 'system',
              name: 'System',
              description: 'Root system'
            }
          ],
          links: [],
          boundaries: {},
          sourceMap: {},
          groups: []
        }
      }
    )

    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'model.scry'
    })
  })

  it('bridges revisioned document reads and node patches through IPC', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-revision-'))
    const send = vi.fn()
    const modelName = 'legacy-draft'

    const first = (await handlers.get('architecture:writeModelDocument')!(
      { sender: { send } },
      {
        projectPath,
        modelName,
        model: {
          nodes: [
            {
              id: 'api',
              type: 'c4',
              data: { name: 'API', description: 'Initial description', kind: 'system' }
            }
          ],
          edges: [],
          sourceMap: {},
          groups: []
        }
      }
    )) as { model: { nodes: { data: Record<string, unknown> }[] }; revision: string }
    expect(first).toMatchObject({
      model: expect.objectContaining({ nodes: expect.any(Array) }),
      revision: expect.any(String)
    })

    const patched = await handlers.get('architecture:patchNodeData')!(
      { sender: { send } },
      {
        projectPath,
        modelName,
        nodeId: 'api',
        patch: { name: 'API Local Draft' },
        baseRevision: first.revision,
        baseNodeData: first.model.nodes[0]!.data
      }
    )

    expect(patched).toMatchObject({
      model: expect.objectContaining({
        nodes: [
          expect.objectContaining({
            data: expect.objectContaining({ name: 'API Local Draft' })
          })
        ]
      }),
      revision: expect.any(String)
    })
    expect(send).toHaveBeenLastCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'legacy-draft.scry'
    })
  })

  it('forwards Native Scryer Engine operation envelopes through IPC', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-engine-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [
          { id: 'api', kind: 'system', name: 'API' },
          { id: 'worker', kind: 'container', name: 'Worker', parentId: 'api' },
          { id: 'web', kind: 'container', name: 'Web', parentId: 'api' }
        ],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )
    const send = vi.fn()

    const result = await handlers.get('architecture:executeScryerOperation')!(
      { sender: { send } },
      {
        projectPath,
        operationId: 'scryer.group.add',
        requestId: 'ipc-test',
        input: {
          items: [
            {
              parent_id: 'api',
              name: 'Runtime',
              member_ids: ['worker', 'web'],
              responsibilities: ['Owns runtime']
            }
          ]
        }
      }
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.group.add',
      requestId: 'ipc-test',
      result: { added: [expect.objectContaining({ kind: 'group' })] }
    })
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
  })

  it('covers focused person.add API wiring through IPC', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-person-add-'))
    const send = vi.fn()

    const result = await handlers.get('architecture:executeScryerOperation')!(
      { sender: { send } },
      {
        projectPath,
        operationId: 'scryer.person.add',
        requestId: 'ipc-person-add',
        input: {
          items: [{ name: 'Customer', description: 'Uses the product' }]
        }
      }
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.person.add',
      requestId: 'ipc-person-add',
      result: { added: [expect.objectContaining({ nodeKind: 'person' })] }
    })
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.nodes).toContainEqual(
      expect.objectContaining({ kind: 'person', name: 'Customer' })
    )
  })

  it('bridges project model management and AI prompt preparation through IPC', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-models-'))

    const template = await handlers.get('architecture:createModel')!(null, {
      projectPath,
      modelName: 'game-plan',
      templateId: 'game'
    })
    expect(template).toMatchObject({
      modelName: 'game-plan',
      model: expect.objectContaining({ nodes: expect.any(Array) })
    })

    await handlers.get('architecture:saveModelAs')!(null, {
      projectPath,
      fromModelName: 'game-plan',
      toModelName: 'game-plan-copy'
    })

    const models = await handlers.get('architecture:listModels')!(null, { projectPath })
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'game-plan' }),
        expect.objectContaining({ name: 'game-plan-copy' })
      ])
    )

    const initialPrompt = await handlers.get('architecture:prepareInitialModelPrompt')!(null, {
      projectPath,
      modelName: 'game-plan'
    })
    expect(initialPrompt).toMatchObject({
      prompt: expect.stringContaining('Build a C4 architecture model named "game-plan"')
    })

    const fillPrompt = await handlers.get('architecture:prepareNodeFillPrompt')!(null, {
      projectPath,
      modelName: 'game-plan',
      nodeId: 'node-2'
    })
    expect(fillPrompt).toMatchObject({
      prompt: expect.stringContaining('Fill out the internals')
    })

    const advisorPrompt = await handlers.get('architecture:prepareAdvisorPrompt')!(null, {
      projectPath,
      modelName: 'game-plan'
    })
    expect(advisorPrompt).toMatchObject({
      prompt: expect.stringContaining('Review the C4 architecture model')
    })

    await handlers.get('architecture:deleteModel')!(null, {
      projectPath,
      modelName: 'game-plan-copy'
    })
    const remaining = await handlers.get('architecture:listModels')!(null, { projectPath })
    expect(remaining).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'game-plan-copy' })])
    )
  })

  it('filters internal and temporary Scryer watcher files', () => {
    expect(shouldNotifyModelFile('model.scry')).toBe(true)
    expect(shouldNotifyModelFile('release-plan.scry')).toBe(true)
    expect(shouldNotifyModelFile('model.baseline.scry')).toBe(false)
    expect(shouldNotifyModelFile('model.presync.scry')).toBe(false)
    expect(shouldNotifyModelFile('.123.tmp')).toBe(false)
    expect(shouldNotifyModelFile('model.scry.tmp')).toBe(false)
  })

  it('starts model watching without creating a legacy default model', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-watch-no-legacy-'))
    const readModel = vi.fn(defaultArchitectureDeps.readModel)
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      readModel
    })

    await handlers.get('architecture:watchModel')!({ sender: { send: vi.fn() } }, { projectPath })

    expect(readModel).not.toHaveBeenCalled()
    await expect(readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8')).rejects.toThrow()
  })

  it('debounces watched model notifications until file writes settle', async () => {
    vi.useFakeTimers()
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-watch-debounce-'))
    const sender = { send: vi.fn() }
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar)

    await handlers.get('architecture:watchModel')!({ sender }, { projectPath })
    expect(watchCallbacks).toHaveLength(1)

    watchCallbacks[0]!('change', 'model.scry')
    await vi.advanceTimersByTimeAsync(20)

    expect(sender.send).not.toHaveBeenCalled()

    watchCallbacks[0]!('change', 'model.scry')
    await vi.advanceTimersByTimeAsync(80)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'model.scry'
    })
    vi.useRealTimers()
  })

  it('keeps model watcher notifications bound to the latest renderer sender', async () => {
    vi.useFakeTimers()
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-watch-resubscribe-'))
    const firstSender = { send: vi.fn(), isDestroyed: vi.fn(() => true) }
    const secondSender = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar)

    await handlers.get('architecture:watchModel')!({ sender: firstSender }, { projectPath })
    await handlers.get('architecture:watchModel')!({ sender: secondSender }, { projectPath })
    expect(watchMock).toHaveBeenCalledTimes(1)

    watchCallbacks[0]!('change', 'planned.scry')
    await vi.advanceTimersByTimeAsync(100)

    expect(firstSender.send).not.toHaveBeenCalled()
    expect(secondSender.send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
    vi.useRealTimers()
  })

  it('writes Claude and Codex MCP config files for the project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-mcp-config-'))
    const result = await handlers.get('architecture:writeMcpConfig')!(null, { projectPath })
    expect(result).toMatchObject({
      claudePath: expect.stringContaining('.mcp.json'),
      codexPath: expect.stringContaining('config.toml')
    })
    expect(await readFile(join(projectPath, '.mcp.json'), 'utf8')).toContain('scryer')
    expect(await readFile(join(projectPath, '.codex', 'config.toml'), 'utf8')).toContain(
      'mcp_servers.scryer'
    )
  })

  it('can register against an injected IPC registrar for isolated tests', async () => {
    const injectedHandlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        injectedHandlers.set(channel, handler as (_event: unknown, args: unknown) => unknown)
      }
    }
    const handleSpy = vi.spyOn(registrar, 'handle')
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-injected-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )

    registerArchitectureHandlers(registrar)

    expect(handleSpy).toHaveBeenCalledWith('architecture:readModel', expect.any(Function))
    expect(
      await injectedHandlers.get('architecture:readModel')!(null, { projectPath })
    ).toMatchObject({
      nodes: [],
      edges: [],
      projectPath
    })
  })
})
