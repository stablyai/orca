/* eslint-disable max-lines -- Why: model-store remains the compatibility facade for existing Scryer storage callers while lower-level path and normalization helpers are split out. */
import { readFile, readdir, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import type { C4ModelData, C4NodeData } from '../../shared/scryer/model-types'
import { parseModelData, serializeModelData } from '../../shared/scryer/parse-model'
import { getBuiltInScryerTemplate } from '../../shared/scryer/templates'
import {
  atomicWrite,
  createBlankModel,
  getGlobalModelPath,
  getGlobalScryerDir,
  getProjectBaselinePath,
  getProjectImplementingPath,
  getProjectModelPath,
  getProjectPreSyncSnapshotPath,
  getProjectScryerDir,
  getProjectSyncPath,
  normalizeModelForProject,
  sanitizeProjectModelName
} from './model-store-core'

export {
  createBlankModel,
  getGlobalModelPath,
  getGlobalScryerDir,
  getProjectBaselinePath,
  getProjectImplementingPath,
  getProjectModelPath,
  getProjectPreSyncSnapshotPath,
  getProjectScryerDir,
  getProjectSyncPath,
  sanitizeProjectModelName
} from './model-store-core'

export type ProjectModelEntry = {
  name: string
  fileName: string
  path: string
  isDefault: boolean
  scope: 'project' | 'global'
}

export type ListProjectModelsOptions = {
  includeGlobal?: boolean
  globalHomePath?: string
}

export type GlobalModelOptions = {
  globalHomePath?: string
}

export type ModelDocument = {
  model: C4ModelData
  revision: string
}

function revisionForContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function readModel(
  projectPath: string,
  modelName?: string | null
): Promise<C4ModelData> {
  return (await readModelDocument(projectPath, modelName)).model
}

export async function readModelDocument(
  projectPath: string,
  modelName?: string | null
): Promise<ModelDocument> {
  const modelPath = getProjectModelPath(projectPath, modelName)
  if (!existsSync(modelPath)) {
    const blank = createBlankModel(projectPath)
    await writeModel(projectPath, blank, modelName)
  }
  let raw: string
  try {
    raw = await readFile(modelPath, 'utf8')
  } catch (error) {
    throw new Error(
      `Failed to read Scryer model: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const parsed = parseModelData(raw)
  return {
    model: normalizeModelForProject(projectPath, parsed),
    revision: revisionForContent(raw)
  }
}

export async function writeModel(
  projectPath: string,
  model: C4ModelData,
  modelName?: string | null
): Promise<void> {
  await writeModelDocument(projectPath, model, modelName)
}

export async function writeModelDocument(
  projectPath: string,
  model: C4ModelData,
  modelName?: string | null,
  options: { baseRevision?: string | null } = {}
): Promise<ModelDocument> {
  if (options.baseRevision) {
    const current = await readModelDocument(projectPath, modelName)
    if (current.revision !== options.baseRevision) {
      throw new Error('Scryer model changed on disk. Reload or merge before saving.')
    }
  }
  const content = serializeModelData(normalizeModelForProject(projectPath, model))
  await atomicWrite(getProjectModelPath(projectPath, modelName), content)
  return {
    model: normalizeModelForProject(projectPath, model),
    revision: revisionForContent(content)
  }
}

export async function patchNodeData(
  projectPath: string,
  args: {
    nodeId: string
    patch: Partial<C4NodeData>
    modelName?: string | null
    baseRevision?: string | null
    baseNodeData?: C4NodeData | null
  }
): Promise<ModelDocument> {
  const current = await readModelDocument(projectPath, args.modelName)
  const target = current.model.nodes.find((node) => node.id === args.nodeId)
  if (!target) {
    throw new Error(`Node '${args.nodeId}' not found`)
  }
  if (args.baseRevision && args.baseRevision !== current.revision && args.baseNodeData) {
    const conflictingKeys = Object.keys(args.patch).filter((key) => {
      const patchKey = key as keyof C4NodeData
      return (
        JSON.stringify(target.data[patchKey]) !== JSON.stringify(args.baseNodeData?.[patchKey]) &&
        JSON.stringify(target.data[patchKey]) !== JSON.stringify(args.patch[patchKey])
      )
    })
    if (conflictingKeys.length > 0) {
      throw new Error(
        `Scryer model changed on disk for ${conflictingKeys.join(', ')}. Reload before saving.`
      )
    }
  }
  const nextModel = {
    ...current.model,
    nodes: current.model.nodes.map((node) =>
      node.id === args.nodeId ? { ...node, data: { ...node.data, ...args.patch } } : node
    )
  }
  return writeModelDocument(projectPath, nextModel, args.modelName)
}

async function listModelFiles(
  dir: string,
  scope: ProjectModelEntry['scope']
): Promise<ProjectModelEntry[]> {
  if (!existsSync(dir)) {
    return []
  }
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scry'))
    .filter((entry) => !entry.name.endsWith('.baseline.scry') && !entry.name.startsWith('.'))
    .map((entry) => {
      const name = entry.name.replace(/\.scry$/i, '')
      return {
        name,
        fileName: entry.name,
        path: join(dir, entry.name),
        isDefault: name === 'model',
        scope
      }
    })
}

function sortModelEntries(entries: ProjectModelEntry[]): ProjectModelEntry[] {
  return [...entries].sort(
    (left, right) =>
      Number(right.scope === 'project') - Number(left.scope === 'project') ||
      Number(right.isDefault) - Number(left.isDefault) ||
      left.name.localeCompare(right.name)
  )
}

export async function listGlobalModels(
  options: GlobalModelOptions = {}
): Promise<ProjectModelEntry[]> {
  return sortModelEntries(
    await listModelFiles(getGlobalScryerDir(options.globalHomePath), 'global')
  )
}

export async function listProjectModels(
  projectPath: string,
  options: ListProjectModelsOptions = {}
): Promise<ProjectModelEntry[]> {
  const projectModels = await listModelFiles(getProjectScryerDir(projectPath), 'project')
  const globalModels =
    options.includeGlobal === false
      ? []
      : await listGlobalModels({ globalHomePath: options.globalHomePath })
  const projectNames = new Set(projectModels.map((entry) => entry.name))
  return sortModelEntries([
    ...projectModels,
    ...globalModels.filter((entry) => !projectNames.has(entry.name))
  ])
}

export async function createProjectModel(
  projectPath: string,
  options: { modelName?: string | null; templateId?: string | null } = {}
): Promise<C4ModelData> {
  const template = options.templateId ? getBuiltInScryerTemplate(options.templateId) : null
  const model = template
    ? normalizeModelForProject(
        projectPath,
        JSON.parse(JSON.stringify(template.model)) as C4ModelData
      )
    : createBlankModel(projectPath)
  await writeModel(projectPath, model, options.modelName)
  return model
}

export async function createGlobalModel(
  globalHomePath: string,
  options: { modelName?: string | null; templateId?: string | null; model?: C4ModelData } = {}
): Promise<C4ModelData> {
  const template = options.templateId ? getBuiltInScryerTemplate(options.templateId) : null
  const model = options.model
    ? normalizeModelForProject(globalHomePath, options.model)
    : template
      ? normalizeModelForProject(
          globalHomePath,
          JSON.parse(JSON.stringify(template.model)) as C4ModelData
        )
      : createBlankModel(globalHomePath)
  await atomicWrite(
    getGlobalModelPath(options.modelName, globalHomePath),
    serializeModelData(normalizeModelForProject(globalHomePath, model))
  )
  return model
}

export async function migrateGlobalModelToProject(
  projectPath: string,
  modelName: string | null | undefined,
  options: GlobalModelOptions = {}
): Promise<{ modelName: string; model: C4ModelData }> {
  const sanitized = sanitizeProjectModelName(modelName)
  const globalPath = getGlobalModelPath(sanitized, options.globalHomePath)
  if (!existsSync(globalPath)) {
    throw new Error(`Global Scryer model '${sanitized}' not found`)
  }
  const parsed = parseModelData(await readFile(globalPath, 'utf8'))
  const model = normalizeModelForProject(projectPath, parsed)
  await writeModel(projectPath, model, sanitized)
  return { modelName: sanitized, model }
}

export async function saveProjectModelAs(
  projectPath: string,
  fromModelName: string | null | undefined,
  toModelName: string
): Promise<C4ModelData> {
  const model = await readModel(projectPath, fromModelName)
  await writeModel(projectPath, model, toModelName)
  return model
}

export async function deleteProjectModel(
  projectPath: string,
  modelName: string | null | undefined
): Promise<void> {
  await rm(getProjectModelPath(projectPath, modelName), { force: true })
}

export async function writeBaseline(projectPath: string, model: C4ModelData): Promise<void> {
  await atomicWrite(getProjectBaselinePath(projectPath), serializeModelData(model))
}

export async function writePreSyncSnapshot(projectPath: string, model: C4ModelData): Promise<void> {
  await atomicWrite(getProjectPreSyncSnapshotPath(projectPath), serializeModelData(model))
}

export async function readBaseline(projectPath: string): Promise<C4ModelData | null> {
  const baselinePath = getProjectBaselinePath(projectPath)
  if (!existsSync(baselinePath)) {
    return null
  }
  return parseModelData(await readFile(baselinePath, 'utf8'))
}

export async function readPreSyncSnapshot(projectPath: string): Promise<C4ModelData | null> {
  const snapshotPath = getProjectPreSyncSnapshotPath(projectPath)
  if (!existsSync(snapshotPath)) {
    return null
  }
  return parseModelData(await readFile(snapshotPath, 'utf8'))
}

export function hasPreSyncSnapshot(projectPath: string): boolean {
  return existsSync(getProjectPreSyncSnapshotPath(projectPath))
}

export async function clearPreSyncSnapshot(projectPath: string): Promise<void> {
  await rm(getProjectPreSyncSnapshotPath(projectPath), { force: true })
}

export async function markSynced(projectPath: string): Promise<void> {
  await atomicWrite(getProjectSyncPath(projectPath), new Date().toISOString())
}

export async function getModelBaselineMtime(projectPath: string): Promise<Date> {
  const candidates = [getProjectSyncPath(projectPath), getProjectModelPath(projectPath)]
  const mtimes: number[] = []
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      mtimes.push((await stat(candidate)).mtime.getTime())
    }
  }
  return new Date(Math.max(...mtimes, 0))
}

export async function setImplementing(projectPath: string, active: boolean): Promise<void> {
  const path = getProjectImplementingPath(projectPath)
  if (active) {
    await atomicWrite(path, '')
    return
  }
  if (existsSync(path)) {
    await rm(path, { force: true })
  }
}

export function isImplementing(projectPath: string): boolean {
  return existsSync(getProjectImplementingPath(projectPath))
}
