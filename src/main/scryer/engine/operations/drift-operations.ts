import { existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import type { ScryModel } from '../model'
import { scryModelSchema } from '../schemas'
import type { ScryerOperationExecutor } from '../types'
import { scryerPaths } from '../paths'
import { success } from './helpers'
import type { RecordInput } from './structural-input'

const DRIFT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.scryer',
  '.next',
  '__pycache__',
  '.direnv',
  '.venv',
  '.turbo',
  '.cache',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.parcel-cache',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.build',
  'bin',
  'obj',
  'pkg'
])

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split(sep).join('/')
  let output = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]
    const afterNext = normalized[index + 2]
    if (char === '*' && next === '*' && afterNext === '/') {
      output += '(?:.*/)?'
      index += 2
    } else if (char === '*' && next === '*') {
      output += '.*'
      index += 1
    } else if (char === '*') {
      output += '[^/]*'
    } else if (char === '?') {
      output += '[^/]'
    } else {
      output += escapeRegex(char ?? '')
    }
  }
  output += '$'
  return new RegExp(output)
}

async function walkProjectFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DRIFT_SKIP_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name))
        }
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name))
      }
    }
  }
  await walk(root)
  return files
}

async function readActiveDriftModel(
  projectRoot: string,
  fallback?: ScryModel
): Promise<ScryModel | null> {
  const paths = scryerPaths(projectRoot)
  if (existsSync(paths.plannedPath)) {
    const parsed = scryModelSchema.safeParse(JSON.parse(await readFile(paths.plannedPath, 'utf8')))
    if (parsed.success) {
      return parsed.data
    }
  }
  return fallback ?? null
}

function modelPatterns(model: ScryModel, nodeId: string): string[] {
  return [
    ...(model.sourceMap[nodeId] ?? []).map((location) => location.pattern),
    ...(model.boundaries[nodeId] ?? []).map((source) => source.pattern)
  ]
}

async function driftedPatternsForNode(
  model: ScryModel,
  nodeId: string,
  files: string[],
  projectRoot: string,
  baseline: Date
): Promise<string[]> {
  const driftedPatterns: string[] = []
  for (const pattern of modelPatterns(model, nodeId).filter(
    (entry, index, all) => entry && all.indexOf(entry) === index
  )) {
    const matcher = globToRegex(pattern)
    for (const file of files) {
      const rel = relative(projectRoot, file).split(sep).join('/')
      if (matcher.test(rel) && (await stat(file)).mtime > baseline) {
        driftedPatterns.push(pattern)
        break
      }
    }
  }
  return driftedPatterns
}

export const driftGetOperation: ScryerOperationExecutor<RecordInput, RecordInput> = async ({
  project,
  state
}) => {
  const model = await readActiveDriftModel(project.projectRoot, state.committed)
  if (!model) {
    return success({ result: { clean: true, scopes: [], baseline: {}, recommendedNextReads: [] } })
  }

  const paths = scryerPaths(project.projectRoot)
  const baseline = existsSync(paths.syncPath) ? (await stat(paths.syncPath)).mtime : new Date(0)
  const files = await walkProjectFiles(project.projectRoot)
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
  const scopes: RecordInput[] = []

  for (const node of model.nodes) {
    const driftedPatterns = await driftedPatternsForNode(
      model,
      node.id,
      files,
      project.projectRoot,
      baseline
    )
    if (driftedPatterns.length === 1) {
      scopes.push({ nodeId: node.id, nodeName: node.name, path: driftedPatterns[0] })
    } else if (driftedPatterns.length > 1) {
      scopes.push({ nodeId: node.id, nodeName: node.name, changedFiles: driftedPatterns })
    }
  }

  const structureChanged = await (async () => {
    for (const file of files) {
      const fileStat = await stat(file)
      const birthtime = fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime
      if (birthtime > baseline) {
        const rel = relative(project.projectRoot, file).split(sep).join('/')
        const covered = scopes.some((scope) => {
          const node = typeof scope.nodeId === 'string' ? nodeById.get(scope.nodeId) : undefined
          return node
            ? modelPatterns(model, node.id).some((pattern) => globToRegex(pattern).test(rel))
            : false
        })
        if (!covered) {
          return true
        }
      }
    }
    return false
  })()

  return success({
    result: {
      clean: scopes.length === 0 && !structureChanged,
      scopes,
      baseline: { syncedAt: baseline.toISOString() },
      recommendedNextReads: []
    }
  })
}

export const driftReconcileOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  services
}) =>
  success({
    result: { reconciledAt: services.clock.nowIso() },
    changes: {
      syncState: { reconciledAt: services.clock.nowIso() },
      anchorBaseline: 'refresh'
    }
  })
