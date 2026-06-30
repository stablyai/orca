/* eslint-disable max-lines -- Why: this IPC registrar remains a compatibility facade for Scryer model, drift, sync, MCP, and prompt handlers while the backing services are split behind injectable deps. */
import { watch, type FSWatcher } from 'fs'
import { mkdir } from 'fs/promises'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  createProjectModel,
  deleteProjectModel,
  getProjectScryerDir,
  hasPreSyncSnapshot,
  isImplementing,
  listProjectModels,
  migrateGlobalModelToProject,
  patchNodeData,
  readModel,
  readModelDocument,
  saveProjectModelAs,
  sanitizeProjectModelName,
  writeModel,
  writeModelDocument
} from '../scryer/model-store'
import { callScryerTool } from '../scryer/mcp-tools'
import { writeArchitectureMcpConfig } from '../scryer/mcp-config'
import { beginSync, cancelSync, finishSync } from '../scryer/sync'
import {
  createArchitectureViewAdapter,
  type ArchitectureViewAdapter
} from '../scryer/architecture-view-adapter'
import {
  createScryerEngine,
  type ScryerEngine,
  type ScryerOperationId,
  type ScryerOperationResult,
  type ScryerReadView,
  type ScryerReadViewInput
} from '../scryer/engine'
import { emptyScryModel } from '../scryer/engine/model'
import {
  createScryerEditSessionController,
  type ScryerEditSessionController
} from '../scryer/edit-session-controller'
import { createScryerEditLeaseStore } from '../scryer/edit-lease-store'
import {
  createScryerMutableAgentRunRuntime,
  type ScryerMutableAgentRunRuntime
} from '../scryer/edit-session-runtime'
import {
  advisorPrompt,
  initialModelPrompt,
  nodeFillPrompt,
  serializeModelForPrompt
} from '../../shared/scryer/prompts'
import type {
  C4ModelData,
  C4NodeData,
  DriftReport,
  ScryerToolCall
} from '../../shared/scryer/model-types'
import { BUILT_IN_SCRYER_TEMPLATES } from '../../shared/scryer/templates'

const watchers = new Map<string, FSWatcher>()
const watcherSubscribers = new Map<string, Set<IpcMainInvokeEvent['sender']>>()
const watcherModelChangedTimers = new Map<string, ReturnType<typeof setTimeout>>()
const WATCHER_MODEL_CHANGED_DEBOUNCE_MS = 75
const READ_VIEW_LOCK_RETRY_DELAYS_MS = [25, 75, 150]
const SCRYER_WRITE_OPERATIONS = new Set<ScryerOperationId>([
  'scryer.node.update',
  'scryer.link.add',
  'scryer.link.delete',
  'scryer.link.update',
  'scryer.node.set-subtree',
  'scryer.node.delete',
  'scryer.node.move',
  'scryer.responsibility.move',
  'scryer.group.set',
  'scryer.group.update',
  'scryer.group.delete',
  'scryer.person.add',
  'scryer.system.add',
  'scryer.container.add',
  'scryer.component.add',
  'scryer.group.add',
  'scryer.symbol.add',
  'scryer.source.update',
  'scryer.plan.fold',
  'scryer.model.set',
  'scryer.container.fill',
  'scryer.node.descope',
  'scryer.drift.flag'
])
const SCRYER_PLAN_FILE_WRITE_OPERATIONS = new Set<ScryerOperationId>([
  'scryer.node.update',
  'scryer.link.add',
  'scryer.link.delete',
  'scryer.link.update',
  'scryer.node.set-subtree',
  'scryer.node.delete',
  'scryer.node.move',
  'scryer.responsibility.move',
  'scryer.group.set',
  'scryer.group.update',
  'scryer.group.delete',
  'scryer.person.add',
  'scryer.system.add',
  'scryer.container.add',
  'scryer.component.add',
  'scryer.group.add',
  'scryer.symbol.add',
  'scryer.source.update',
  'scryer.drift.flag'
])

export type ArchitectureIpcRegistrar = {
  handle: <Args>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, args: Args) => unknown
  ) => void
}

export type ArchitectureHandlerDeps = {
  createProjectModel: typeof createProjectModel
  deleteProjectModel: typeof deleteProjectModel
  getProjectScryerDir: typeof getProjectScryerDir
  hasPreSyncSnapshot: typeof hasPreSyncSnapshot
  isImplementing: typeof isImplementing
  listProjectModels: typeof listProjectModels
  migrateGlobalModelToProject: typeof migrateGlobalModelToProject
  patchNodeData: typeof patchNodeData
  readModel: typeof readModel
  readModelDocument: typeof readModelDocument
  saveProjectModelAs: typeof saveProjectModelAs
  sanitizeProjectModelName: typeof sanitizeProjectModelName
  writeModel: typeof writeModel
  writeModelDocument: typeof writeModelDocument
  callScryerTool: typeof callScryerTool
  scryerEngine: ScryerEngine
  architectureViewAdapter: ArchitectureViewAdapter
  writeArchitectureMcpConfig: typeof writeArchitectureMcpConfig
  beginSync: typeof beginSync
  cancelSync: typeof cancelSync
  finishSync: typeof finishSync
  scryerEditSessionController?: ScryerEditSessionController
  scryerAgentRunRuntime?: ScryerMutableAgentRunRuntime
}

const defaultScryerEngine = createScryerEngine()
const defaultArchitectureViewAdapter = createArchitectureViewAdapter(defaultScryerEngine)
const defaultScryerAgentRunRuntime = createScryerMutableAgentRunRuntime()

export const defaultArchitectureDeps: ArchitectureHandlerDeps = {
  createProjectModel,
  deleteProjectModel,
  getProjectScryerDir,
  hasPreSyncSnapshot,
  isImplementing,
  listProjectModels,
  migrateGlobalModelToProject,
  patchNodeData,
  readModel,
  readModelDocument,
  saveProjectModelAs,
  sanitizeProjectModelName,
  writeModel,
  writeModelDocument,
  callScryerTool,
  scryerEngine: defaultScryerEngine,
  architectureViewAdapter: defaultArchitectureViewAdapter,
  writeArchitectureMcpConfig,
  beginSync,
  cancelSync,
  finishSync,
  scryerEditSessionController: createScryerEditSessionController({
    engine: defaultScryerEngine,
    leaseStore: createScryerEditLeaseStore(),
    agentRuntime: defaultScryerAgentRunRuntime
  }),
  scryerAgentRunRuntime: defaultScryerAgentRunRuntime
}

export function shouldNotifyModelFile(filename: string | Buffer): boolean {
  const name = String(filename)
  if (!name || name.startsWith('.') || name.endsWith('.tmp')) {
    return false
  }
  if (!name.endsWith('.scry')) {
    return false
  }
  return !name.endsWith('.baseline.scry') && !name.endsWith('.presync.scry')
}

function projectKey(projectPath: string, deps: ArchitectureHandlerDeps): string {
  return deps.getProjectScryerDir(projectPath)
}

function notifyModelChanged(
  event: IpcMainInvokeEvent | null,
  projectPath: string,
  modelName: string | null | undefined,
  deps: ArchitectureHandlerDeps
): void {
  notifyModelFileChanged(event, projectPath, `${deps.sanitizeProjectModelName(modelName)}.scry`)
}

function notifyModelFileChanged(
  event: IpcMainInvokeEvent | null,
  projectPath: string,
  fileName: string
): void {
  event?.sender.send('architecture:modelChanged', {
    projectPath,
    fileName
  })
}

export function changedScryerModelFileForOperation(operationId: ScryerOperationId): string {
  return SCRYER_PLAN_FILE_WRITE_OPERATIONS.has(operationId) ? 'planned.scry' : 'model.scry'
}

function notifyWatchedModelChanged(key: string, projectPath: string, fileName: string): void {
  const subscribers = watcherSubscribers.get(key)
  if (!subscribers) {
    return
  }
  for (const sender of subscribers) {
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      subscribers.delete(sender)
      continue
    }
    sender.send('architecture:modelChanged', { projectPath, fileName })
  }
}

function scheduleWatchedModelChanged(key: string, projectPath: string, fileName: string): void {
  const timerKey = `${projectPath}\0${fileName}`
  const currentTimer = watcherModelChangedTimers.get(timerKey)
  if (currentTimer) {
    clearTimeout(currentTimer)
  }
  const timer = setTimeout(() => {
    watcherModelChangedTimers.delete(timerKey)
    notifyWatchedModelChanged(key, projectPath, fileName)
  }, WATCHER_MODEL_CHANGED_DEBOUNCE_MS)
  watcherModelChangedTimers.set(timerKey, timer)
}

function isDefaultModelName(
  modelName: string | null | undefined,
  deps: Pick<ArchitectureHandlerDeps, 'sanitizeProjectModelName'>
): boolean {
  return deps.sanitizeProjectModelName(modelName) === 'model'
}

function contextForEngine(projectPath: string, requestIdPrefix: string) {
  return {
    requestId: `${requestIdPrefix}-${Date.now()}`,
    transport: 'ipc' as const,
    caller: 'human' as const,
    cwd: projectPath,
    projectRoot: projectPath
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readViewWithLockRetry(
  deps: ArchitectureHandlerDeps,
  input: ScryerReadViewInput,
  projectPath: string,
  requestIdPrefix: string
): Promise<ScryerOperationResult<ScryerReadView>> {
  for (let attempt = 0; attempt <= READ_VIEW_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = await deps.scryerEngine.readView(
      input,
      contextForEngine(projectPath, `${requestIdPrefix}-${attempt + 1}`)
    )
    if (result.ok || result.error.code !== 'lock_busy') {
      return result
    }
    const retryDelay = READ_VIEW_LOCK_RETRY_DELAYS_MS[attempt]
    if (retryDelay === undefined) {
      return result
    }
    await wait(retryDelay)
  }
  return deps.scryerEngine.readView(input, contextForEngine(projectPath, requestIdPrefix))
}

function requireEditSessionController(deps: ArchitectureHandlerDeps): ScryerEditSessionController {
  if (!deps.scryerEditSessionController) {
    throw new Error('Scryer edit-session controller is not configured')
  }
  return deps.scryerEditSessionController
}

async function ensureNoActiveEditSession(
  projectPath: string,
  deps: ArchitectureHandlerDeps
): Promise<void> {
  const session = await deps.scryerEditSessionController?.readEditSession({ projectPath })
  if (session?.activeLease) {
    throw new Error('A Scryer edit session is active; semantic writes must use the session lease.')
  }
}

async function writeDefaultScryModelThroughEngine(
  projectPath: string,
  model: unknown,
  deps: ArchitectureHandlerDeps
): Promise<{ model: unknown; revision: string }> {
  const result = await deps.scryerEngine.executeOperation(
    'scryer.model.set',
    { data: model },
    contextForEngine(projectPath, 'ipc-model-set')
  )
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return { model, revision: result.requestId }
}

function architectureModelFromReadView(
  projectPath: string,
  result: unknown,
  extensionState?: Pick<C4ModelData, 'refPositions' | 'startingLevel' | 'validationWarnings'> | null
): C4ModelData | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const readResult = result as { fullModel?: unknown; model?: unknown }
  const rawModel = readResult.fullModel ?? readResult.model
  if (typeof rawModel !== 'object' || rawModel === null) {
    return null
  }
  const model = rawModel as {
    nodes?: Record<string, unknown>[]
    links?: Record<string, unknown>[]
    groups?: Record<string, unknown>[]
    sourceMap?: C4ModelData['sourceMap']
  }
  return {
    projectPath,
    nodes: (model.nodes ?? []).map((node) => {
      const kind = typeof node.kind === 'string' ? node.kind : 'system'
      return {
        id: String(node.id),
        type: kind === 'symbol' ? 'operation' : 'c4',
        position: { x: 0, y: 0 },
        parentId: typeof node.parentId === 'string' ? node.parentId : undefined,
        data: {
          name: typeof node.name === 'string' ? node.name : String(node.id),
          description: typeof node.description === 'string' ? node.description : '',
          kind: kind === 'symbol' ? 'operation' : kind,
          ...(typeof node.technology === 'string' ? { technology: node.technology } : {}),
          ...(typeof node.external === 'boolean' ? { external: node.external } : {}),
          ...(Array.isArray(node.properties) ? { properties: node.properties } : {}),
          _needsLayout: true
        }
      }
    }) as C4ModelData['nodes'],
    edges: (model.links ?? []).map((link) => ({
      id: String(link.id),
      source: String(link.src),
      target: String(link.dst),
      data: {
        label: typeof link.label === 'string' ? link.label : '',
        ...(typeof link.method === 'string' ? { method: link.method } : {})
      }
    })),
    groups: (model.groups ?? []).map((group) => ({
      id: String(group.id),
      name: typeof group.name === 'string' ? group.name : String(group.id),
      memberIds: Array.isArray(group.memberIds)
        ? group.memberIds.filter((member): member is string => typeof member === 'string')
        : [],
      ...(typeof group.description === 'string' ? { description: group.description } : {}),
      ...(typeof group.parentGroupId === 'string' ? { parentGroupId: group.parentGroupId } : {})
    })),
    sourceMap: model.sourceMap ?? {},
    ...(extensionState?.refPositions ? { refPositions: extensionState.refPositions } : {}),
    ...(extensionState?.startingLevel ? { startingLevel: extensionState.startingLevel } : {}),
    ...(extensionState?.validationWarnings
      ? { validationWarnings: extensionState.validationWarnings }
      : {})
  }
}

async function readModelForPrompt(
  projectPath: string,
  modelName: string | null | undefined,
  deps: ArchitectureHandlerDeps,
  requestIdPrefix: string
): Promise<C4ModelData> {
  if (!isDefaultModelName(modelName, deps)) {
    return deps.readModel(projectPath, modelName)
  }
  const view = await readViewWithLockRetry(deps, { layer: 'plan' }, projectPath, requestIdPrefix)
  if (!view.ok) {
    throw new Error(view.error.message)
  }
  const model = architectureModelFromReadView(projectPath, view.result)
  if (model) {
    return model
  }
  throw new Error('Scryer readView result did not include a full model for prompt preparation')
}

async function readRendererExtensionState(
  projectPath: string,
  modelName: string | null | undefined,
  deps: ArchitectureHandlerDeps
): Promise<Pick<C4ModelData, 'refPositions' | 'startingLevel' | 'validationWarnings'> | null> {
  if (isDefaultModelName(modelName, deps)) {
    return null
  }
  try {
    const model = await deps.readModel(projectPath, modelName)
    return {
      refPositions: model.refPositions,
      startingLevel: model.startingLevel,
      validationWarnings: model.validationWarnings
    }
  } catch {
    return null
  }
}

function nodeUpdateInputFromPatch(args: {
  nodeId: string
  patch: Partial<C4NodeData>
}): { nodes: Record<string, unknown>[] } | null {
  const node: Record<string, unknown> = { node_id: args.nodeId }
  if (typeof args.patch.name === 'string') {
    node.name = args.patch.name
  }
  if (typeof args.patch.description === 'string') {
    node.description = args.patch.description
  }
  if (typeof args.patch.technology === 'string') {
    node.technology = args.patch.technology
  }
  if (typeof args.patch.external === 'boolean') {
    node.external = args.patch.external
  }
  if (Array.isArray(args.patch.properties)) {
    node.properties = args.patch.properties
  }
  if (typeof args.patch.kind === 'string') {
    node.kind =
      args.patch.kind === 'operation' ||
      args.patch.kind === 'process' ||
      args.patch.kind === 'model'
        ? 'symbol'
        : args.patch.kind
  }
  return Object.keys(node).length > 1 ? { nodes: [node] } : null
}

function driftReportFromEngineResult(result: unknown): DriftReport | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const record = result as {
    clean?: unknown
    scopes?: Record<string, unknown>[]
  }
  if (!Array.isArray(record.scopes)) {
    return null
  }
  return {
    nodes: record.scopes.map((scope) => ({
      nodeId: String(scope.nodeId),
      nodeName: typeof scope.nodeName === 'string' ? scope.nodeName : '',
      patterns:
        typeof scope.path === 'string'
          ? [scope.path]
          : Array.isArray(scope.changedFiles)
            ? scope.changedFiles.filter((item): item is string => typeof item === 'string')
            : []
    })),
    structureChanged: record.clean === false && record.scopes.length === 0
  }
}

export function closeArchitectureWatchers(): void {
  for (const watcher of watchers.values()) {
    watcher.close()
  }
  watchers.clear()
  watcherSubscribers.clear()
  for (const timer of watcherModelChangedTimers.values()) {
    clearTimeout(timer)
  }
  watcherModelChangedTimers.clear()
}

export function registerArchitectureHandlers(
  registrar: ArchitectureIpcRegistrar = ipcMain,
  deps: ArchitectureHandlerDeps = defaultArchitectureDeps
): void {
  registrar.handle(
    'architecture:readArchitectureView',
    async (
      _event,
      args: { projectPath: string; layer?: 'plan' | 'committed'; focusNodeId?: string | null }
    ) =>
      deps.architectureViewAdapter.readArchitectureView(
        args,
        contextForEngine(args.projectPath, 'ipc-architecture-view')
      )
  )

  registrar.handle(
    'architecture:readModel',
    async (_event, args: { projectPath: string; modelName?: string | null }) => {
      if (!isDefaultModelName(args.modelName, deps)) {
        return deps.readModel(args.projectPath, args.modelName)
      }
      const view = await readViewWithLockRetry(
        deps,
        { layer: 'committed' },
        args.projectPath,
        'ipc-read'
      )
      if (!view.ok) {
        throw new Error(view.error.message)
      }
      const extensionState = await readRendererExtensionState(
        args.projectPath,
        args.modelName,
        deps
      )
      const model = architectureModelFromReadView(args.projectPath, view.result, extensionState)
      if (model) {
        return model
      }
      throw new Error('Scryer readView result did not include a full model for renderer mapping')
    }
  )

  registrar.handle(
    'architecture:readModelDocument',
    async (_event, args: { projectPath: string; modelName?: string | null }) => {
      if (!isDefaultModelName(args.modelName, deps)) {
        return deps.readModelDocument(args.projectPath, args.modelName)
      }
      const view = await readViewWithLockRetry(
        deps,
        { layer: 'committed' },
        args.projectPath,
        'ipc-read-document'
      )
      if (!view.ok) {
        throw new Error(view.error.message)
      }
      const extensionState = await readRendererExtensionState(
        args.projectPath,
        args.modelName,
        deps
      )
      const model = architectureModelFromReadView(args.projectPath, view.result, extensionState)
      if (model) {
        return { model, revision: view.requestId }
      }
      throw new Error('Scryer readView result did not include a full model for renderer mapping')
    }
  )

  registrar.handle(
    'architecture:writeModel',
    async (event, args: { projectPath: string; model: unknown; modelName?: string | null }) => {
      if (isDefaultModelName(args.modelName, deps)) {
        await ensureNoActiveEditSession(args.projectPath, deps)
        await writeDefaultScryModelThroughEngine(args.projectPath, args.model, deps)
        notifyModelChanged(event, args.projectPath, args.modelName, deps)
        return
      }
      await deps.writeModel(args.projectPath, args.model as C4ModelData, args.modelName)
      notifyModelChanged(event, args.projectPath, args.modelName, deps)
    }
  )

  registrar.handle(
    'architecture:writeModelDocument',
    async (
      event,
      args: {
        projectPath: string
        model: unknown
        modelName?: string | null
        baseRevision?: string | null
      }
    ) => {
      if (isDefaultModelName(args.modelName, deps)) {
        await ensureNoActiveEditSession(args.projectPath, deps)
        const result = await writeDefaultScryModelThroughEngine(args.projectPath, args.model, deps)
        notifyModelChanged(event, args.projectPath, args.modelName, deps)
        return result
      }
      const result = await deps.writeModelDocument(
        args.projectPath,
        args.model as C4ModelData,
        args.modelName,
        {
          baseRevision: args.baseRevision
        }
      )
      notifyModelChanged(event, args.projectPath, args.modelName, deps)
      return result
    }
  )

  registrar.handle(
    'architecture:patchNodeData',
    async (
      event,
      args: {
        projectPath: string
        nodeId: string
        patch: Partial<C4NodeData>
        modelName?: string | null
        baseRevision?: string | null
        baseNodeData?: C4NodeData | null
      }
    ) => {
      if (isDefaultModelName(args.modelName, deps)) {
        const input = nodeUpdateInputFromPatch(args)
        if (!input) {
          throw new Error('Node patch does not contain any cataloged Scryer node fields')
        }
        const result = await deps.scryerEngine.executeOperation(
          'scryer.node.update',
          input,
          contextForEngine(args.projectPath, 'ipc-node-update')
        )
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        const view = await deps.scryerEngine.readView(
          { layer: 'plan' },
          contextForEngine(args.projectPath, 'ipc-read')
        )
        if (!view.ok) {
          throw new Error(view.error.message)
        }
        const extensionState = await readRendererExtensionState(
          args.projectPath,
          args.modelName,
          deps
        )
        const model = architectureModelFromReadView(args.projectPath, view.result, extensionState)
        if (model) {
          notifyModelFileChanged(event, args.projectPath, 'planned.scry')
          return { model, revision: result.requestId }
        }
        throw new Error('Scryer readView result did not include a full model for renderer mapping')
      }
      const result = await deps.patchNodeData(args.projectPath, args)
      notifyModelChanged(event, args.projectPath, args.modelName, deps)
      return result
    }
  )

  registrar.handle('architecture:listModels', (_event, args: { projectPath: string }) =>
    deps.listProjectModels(args.projectPath)
  )

  registrar.handle(
    'architecture:migrateGlobalModel',
    async (event, args: { projectPath: string; modelName: string }) => {
      const result = await deps.migrateGlobalModelToProject(args.projectPath, args.modelName)
      notifyModelChanged(event, args.projectPath, result.modelName, deps)
      return result
    }
  )

  registrar.handle(
    'architecture:createModel',
    async (
      event,
      args: { projectPath: string; modelName?: string | null; templateId?: string | null }
    ) => {
      if (isDefaultModelName(args.modelName, deps) && !args.templateId) {
        await ensureNoActiveEditSession(args.projectPath, deps)
        const result = await writeDefaultScryModelThroughEngine(
          args.projectPath,
          emptyScryModel(),
          deps
        )
        const view = await readViewWithLockRetry(
          deps,
          { layer: 'committed' },
          args.projectPath,
          'ipc-create-model'
        )
        if (!view.ok) {
          throw new Error(view.error.message)
        }
        const extensionState = await readRendererExtensionState(
          args.projectPath,
          args.modelName,
          deps
        )
        const model = architectureModelFromReadView(args.projectPath, view.result, extensionState)
        if (!model) {
          throw new Error(
            'Scryer readView result did not include a full model for renderer mapping'
          )
        }
        notifyModelChanged(event, args.projectPath, args.modelName, deps)
        return {
          modelName: deps.sanitizeProjectModelName(args.modelName),
          model,
          revision: result.revision
        }
      }
      const model = await deps.createProjectModel(args.projectPath, {
        modelName: args.modelName,
        templateId: args.templateId
      })
      notifyModelChanged(event, args.projectPath, args.modelName, deps)
      return { modelName: deps.sanitizeProjectModelName(args.modelName), model }
    }
  )

  registrar.handle(
    'architecture:saveModelAs',
    async (
      event,
      args: { projectPath: string; fromModelName?: string | null; toModelName: string }
    ) => {
      const model = await deps.saveProjectModelAs(
        args.projectPath,
        args.fromModelName,
        args.toModelName
      )
      notifyModelChanged(event, args.projectPath, args.toModelName, deps)
      return { modelName: deps.sanitizeProjectModelName(args.toModelName), model }
    }
  )

  registrar.handle(
    'architecture:deleteModel',
    async (event, args: { projectPath: string; modelName: string }) => {
      await deps.deleteProjectModel(args.projectPath, args.modelName)
      notifyModelChanged(event, args.projectPath, args.modelName, deps)
    }
  )

  registrar.handle('architecture:listTemplates', () =>
    BUILT_IN_SCRYER_TEMPLATES.map((template) => ({ id: template.id, name: template.name }))
  )

  registrar.handle('architecture:writeMcpConfig', (_event, args: { projectPath: string }) =>
    deps.writeArchitectureMcpConfig(args.projectPath)
  )

  registrar.handle(
    'architecture:prepareInitialModelPrompt',
    (_event, args: { projectPath: string; modelName: string }) => ({
      prompt: initialModelPrompt(args.modelName, args.projectPath)
    })
  )

  registrar.handle(
    'architecture:prepareNodeFillPrompt',
    async (_event, args: { projectPath: string; modelName?: string | null; nodeId: string }) => {
      const model = await readModelForPrompt(
        args.projectPath,
        args.modelName,
        deps,
        'ipc-node-fill-prompt'
      )
      const node = model.nodes.find((candidate) => candidate.id === args.nodeId)
      if (!node) {
        throw new Error(`Node '${args.nodeId}' not found`)
      }
      return {
        prompt: nodeFillPrompt({
          modelName: deps.sanitizeProjectModelName(args.modelName),
          cwd: args.projectPath,
          nodeId: node.id,
          nodeName: node.data.name,
          nodeKind: node.data.kind,
          modelJson: serializeModelForPrompt(model)
        })
      }
    }
  )

  registrar.handle(
    'architecture:prepareAdvisorPrompt',
    async (_event, args: { projectPath: string; modelName?: string | null }) => {
      const model = await readModelForPrompt(
        args.projectPath,
        args.modelName,
        deps,
        'ipc-advisor-prompt'
      )
      return {
        prompt: advisorPrompt({
          modelName: deps.sanitizeProjectModelName(args.modelName),
          cwd: args.projectPath,
          modelJson: serializeModelForPrompt(model)
        })
      }
    }
  )

  registrar.handle('architecture:checkDrift', async (_event, args: { projectPath: string }) => {
    const result = await deps.scryerEngine.executeOperation(
      'scryer.drift.get',
      {},
      contextForEngine(args.projectPath, 'ipc-drift')
    )
    if (result.ok) {
      return driftReportFromEngineResult(result.result) ?? { nodes: [], structureChanged: false }
    }
    throw new Error(result.error.message)
  })

  registrar.handle('architecture:markSynced', async (_event, args: { projectPath: string }) => {
    const result = await deps.scryerEngine.executeOperation(
      'scryer.drift.reconcile',
      {},
      contextForEngine(args.projectPath, 'ipc-reconcile')
    )
    return result
  })

  registrar.handle('architecture:isSyncing', (_event, args: { projectPath: string }) =>
    deps.isImplementing(args.projectPath)
  )

  registrar.handle('architecture:hasPreSyncSnapshot', (_event, args: { projectPath: string }) =>
    deps.hasPreSyncSnapshot(args.projectPath)
  )

  registrar.handle(
    'architecture:beginSync',
    (_event, args: { projectPath: string; modelName?: string }) =>
      deps.beginSync(args.projectPath, { modelName: args.modelName })
  )

  registrar.handle('architecture:cancelSync', (_event, args: { projectPath: string }) =>
    deps.cancelSync(args.projectPath)
  )

  registrar.handle('architecture:finishSync', async (_event, args: { projectPath: string }) => {
    await deps.finishSync(args.projectPath)
  })

  registrar.handle(
    'architecture:beginEditSession',
    (_event, args: { projectPath: string; agentRunId: string }) => {
      deps.scryerAgentRunRuntime?.setRunStatus(args.agentRunId, 'running', { emit: false })
      return requireEditSessionController(deps).beginAgentEditSession(args)
    }
  )

  registrar.handle(
    'architecture:completeEditSession',
    async (
      event,
      args: {
        projectPath: string
        agentRunId: string
        foldPolicy?: 'never' | 'when_gate_passes'
      }
    ) => {
      deps.scryerAgentRunRuntime?.setRunStatus(args.agentRunId, 'done', { emit: false })
      const result = await requireEditSessionController(deps).completeAgentEditSession(args)
      deps.scryerAgentRunRuntime?.clearRun(args.agentRunId)
      if (args.foldPolicy === 'when_gate_passes' && result.foldAllowed) {
        notifyModelChanged(event, args.projectPath, undefined, deps)
      }
      return result
    }
  )

  registrar.handle(
    'architecture:cancelEditSession',
    async (_event, args: { projectPath: string; agentRunId: string }) => {
      deps.scryerAgentRunRuntime?.setRunStatus(args.agentRunId, 'cancelled', { emit: false })
      await requireEditSessionController(deps).cancelAgentEditSession(args)
      deps.scryerAgentRunRuntime?.clearRun(args.agentRunId)
    }
  )

  registrar.handle('architecture:readEditSession', (_event, args: { projectPath: string }) =>
    requireEditSessionController(deps).readEditSession(args)
  )

  registrar.handle(
    'architecture:callTool',
    async (event, args: { projectPath: string; call: ScryerToolCall }) => {
      const result = await deps.callScryerTool(args.projectPath, args.call)
      if (result.ok) {
        notifyModelChanged(event, args.projectPath, undefined, deps)
      }
      return result
    }
  )

  registrar.handle(
    'architecture:executeScryerOperation',
    async (
      event,
      args: {
        projectPath: string
        operationId: ScryerOperationId
        input?: unknown
        requestId?: string
      }
    ) => {
      const result = await deps.scryerEngine.executeOperation(args.operationId, args.input ?? {}, {
        requestId: args.requestId ?? `ipc-${Date.now()}`,
        transport: 'ipc',
        caller: 'human',
        cwd: args.projectPath,
        projectRoot: args.projectPath
      })
      if (result.ok && SCRYER_WRITE_OPERATIONS.has(args.operationId)) {
        notifyModelFileChanged(
          event,
          args.projectPath,
          changedScryerModelFileForOperation(args.operationId)
        )
      }
      return result
    }
  )

  registrar.handle('architecture:watchModel', async (event, args: { projectPath: string }) => {
    const key = projectKey(args.projectPath, deps)
    const subscribers = watcherSubscribers.get(key) ?? new Set<IpcMainInvokeEvent['sender']>()
    subscribers.add(event.sender)
    watcherSubscribers.set(key, subscribers)
    if (watchers.has(key)) {
      return
    }
    await mkdir(key, { recursive: true })
    const watcher = watch(key, { persistent: false }, (_eventType, filename) => {
      if (!filename || !shouldNotifyModelFile(filename)) {
        return
      }
      scheduleWatchedModelChanged(key, args.projectPath, String(filename))
    })
    watcher.on('error', () => {
      watchers.delete(key)
      watcherSubscribers.delete(key)
    })
    watchers.set(key, watcher)
  })
}
