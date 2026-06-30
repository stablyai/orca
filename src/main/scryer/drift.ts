import { readdir, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import type { C4ModelData, DriftReport } from '../../shared/scryer/model-types'
import { getModelBaselineMtime, readModel } from './model-store'

const SKIP_DIRS = new Set([
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
  '.webpack',
  'vendor'
])

const SKIP_BUILD_DIRS = new Set(['dist', 'build', 'out', 'target', '.build', 'bin', 'obj', 'pkg'])

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split(sep).join('/')
  let output = '^'
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    const next = normalized[i + 1]
    const afterNext = normalized[i + 2]
    if (char === '*' && next === '*' && afterNext === '/') {
      output += '(?:.*/)?'
      i += 2
    } else if (char === '*' && next === '*') {
      output += '.*'
      i++
    } else if (char === '*') {
      output += '[^/]*'
    } else if (char === '?') {
      output += '[^/]'
    } else {
      output += escapeRegex(char)
    }
  }
  output += '$'
  return new RegExp(output)
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_BUILD_DIRS.has(entry.name)) {
          continue
        }
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        result.push(join(dir, entry.name))
      }
    }
  }
  await walk(root)
  return result
}

async function checkSourceDrift(
  model: C4ModelData,
  baseline: Date,
  projectPath: string,
  files: string[]
): Promise<DriftReport['nodes']> {
  const drifted: DriftReport['nodes'] = []
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
  for (const [nodeId, locations] of Object.entries(model.sourceMap ?? {})) {
    const patterns: string[] = []
    for (const location of locations) {
      const matcher = globToRegex(location.pattern)
      for (const file of files) {
        const rel = relative(projectPath, file).split(sep).join('/')
        if (!matcher.test(rel)) {
          continue
        }
        if ((await stat(file)).mtime > baseline) {
          patterns.push(location.pattern)
          break
        }
      }
    }
    if (patterns.length > 0) {
      drifted.push({
        nodeId,
        nodeName: nodeById.get(nodeId)?.data.name ?? '',
        patterns
      })
    }
  }
  return drifted
}

async function checkStructureDrift(files: string[], baseline: Date): Promise<boolean> {
  for (const file of files) {
    const fileStat = await stat(file)
    const birthtime = fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime
    if (birthtime > baseline) {
      return true
    }
  }
  return false
}

export async function checkDrift(projectPath: string): Promise<DriftReport> {
  const [model, baseline, files] = await Promise.all([
    readModel(projectPath),
    getModelBaselineMtime(projectPath),
    walkFiles(projectPath)
  ])
  return {
    nodes: await checkSourceDrift(model, baseline, projectPath, files),
    structureChanged: await checkStructureDrift(files, baseline)
  }
}
