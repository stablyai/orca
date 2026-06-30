import { readFile, readdir, realpath, stat } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import type {
  ResolvedScryerProject,
  ScryerCodebaseEntry,
  ScryerCodebaseMarker,
  ScryerCodebaseReadInput,
  ScryerCodebaseReadResult,
  ScryerOperationExecutor
} from '../types'
import { failure, success } from './operation-result'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_ENTRIES = 200
const SKIPPED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.scryer',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor'
])
const MANIFEST_FILES = new Set([
  'Cargo.toml',
  'Gemfile',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts'
])
const INFRA_FILES = new Set([
  '.gitlab-ci.yaml',
  '.gitlab-ci.yml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'fly.toml'
])
const ENVIRONMENT_FILES = new Set(['.env.example', '.env.sample', '.env.template'])

type IgnoreRule = {
  raw: string
  directoryOnly: boolean
  anchored: boolean
}

function posixPath(value: string): string {
  return value.split(sep).join('/')
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function readIgnoreRules(projectRoot: string): Promise<IgnoreRule[]> {
  try {
    const raw = await readFile(resolve(projectRoot, '.gitignore'), 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
      .map((line) => ({
        raw: line.replace(/^\/+/, '').replace(/\/+$/, ''),
        directoryOnly: line.endsWith('/'),
        anchored: line.startsWith('/')
      }))
      .filter((rule) => rule.raw.length > 0)
  } catch {
    return []
  }
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function ignoredByRule(rule: IgnoreRule, relPath: string, name: string, isDirectory: boolean) {
  if (rule.directoryOnly && !isDirectory) {
    return false
  }
  if (rule.raw.includes('*')) {
    return globMatch(rule.raw, relPath) || globMatch(rule.raw, name)
  }
  if (!rule.raw.includes('/') && !rule.anchored) {
    return relPath.split('/').includes(rule.raw) || name === rule.raw
  }
  return relPath === rule.raw || relPath.startsWith(`${rule.raw}/`)
}

function markersFor(projectRelativePath: string, name: string): ScryerCodebaseMarker[] {
  const markers: ScryerCodebaseMarker[] = []
  if (MANIFEST_FILES.has(name)) {
    markers.push('manifest')
  }
  if (
    INFRA_FILES.has(name) ||
    name.endsWith('.tf') ||
    name.endsWith('.tfvars') ||
    projectRelativePath.startsWith('.github/workflows/') ||
    projectRelativePath.startsWith('.gitea/workflows/') ||
    projectRelativePath.startsWith('.forgejo/workflows/')
  ) {
    markers.push('infrastructure')
  }
  if (ENVIRONMENT_FILES.has(name)) {
    markers.push('environment')
  }
  return markers
}

function ioFailure(message: string, path: string, cause?: unknown) {
  return failure('io_error', message, {
    target: 'project_tree',
    operation: 'read',
    path,
    ...(cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : {})
  })
}

function invalidPathFailure(message: string, path: string) {
  return failure('invalid_input', message, undefined, {
    fieldErrors: [{ path: 'path', message, code: 'outside_project_root' }],
    path
  })
}

async function scanProjectTree(
  project: ResolvedScryerProject,
  input: ScryerCodebaseReadInput
): Promise<ScryerCodebaseReadResult | ReturnType<typeof failure>> {
  const projectRoot = resolve(project.projectRoot)
  const scanRoot = resolve(projectRoot, input.path ?? '.')
  if (!inside(projectRoot, scanRoot)) {
    return invalidPathFailure('codebase.read path must stay inside the project root', scanRoot)
  }
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
  try {
    const [projectRealPath, scanRealPath, rootStat] = await Promise.all([
      realpath(projectRoot),
      realpath(scanRoot),
      stat(scanRoot)
    ])
    if (!inside(projectRealPath, scanRealPath)) {
      return invalidPathFailure('codebase.read path must stay inside the project root', scanRoot)
    }
    if (!rootStat.isDirectory()) {
      return ioFailure('codebase.read path must be a directory', scanRoot)
    }
  } catch (error) {
    return ioFailure('Failed to read codebase path', scanRoot, error)
  }

  const ignoreRules = await readIgnoreRules(projectRoot)
  const entries: ScryerCodebaseEntry[] = []
  let truncated = false
  let skippedCount = 0

  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated) {
      return
    }
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
    const sorted = children
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || Number(left.isFile()) - Number(right.isFile())
      )
    for (const child of sorted) {
      const fullPath = resolve(directory, child.name)
      const projectRel = posixPath(relative(projectRoot, fullPath))
      const entryRel = posixPath(relative(scanRoot, fullPath))
      const isDirectory = child.isDirectory()
      const ignored =
        (isDirectory && SKIPPED_DIRECTORIES.has(child.name)) ||
        ignoreRules.some((rule) => ignoredByRule(rule, projectRel, child.name, isDirectory))
      if (ignored) {
        skippedCount += 1
        continue
      }
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      entries.push({
        path: entryRel,
        name: child.name,
        kind: isDirectory ? 'directory' : 'file',
        depth,
        markers: markersFor(projectRel, child.name)
      })
      if (isDirectory) {
        if (depth >= maxDepth) {
          truncated = true
        } else {
          await walk(fullPath, depth + 1)
        }
      }
    }
  }

  try {
    await walk(scanRoot, 0)
  } catch (error) {
    return ioFailure('Failed to scan codebase path', scanRoot, error)
  }

  const fileCount = entries.filter((entry) => entry.kind === 'file').length
  const directoryCount = entries.filter((entry) => entry.kind === 'directory').length
  const manifestCount = entries.filter((entry) => entry.markers.includes('manifest')).length
  const infrastructureCount = entries.filter((entry) =>
    entry.markers.includes('infrastructure')
  ).length
  const environmentCount = entries.filter((entry) => entry.markers.includes('environment')).length
  return {
    root: scanRoot,
    entries,
    summary: {
      fileCount,
      directoryCount,
      manifestCount,
      infrastructureCount,
      environmentCount,
      skippedCount
    },
    truncated
  }
}

export const codebaseReadOperation: ScryerOperationExecutor<
  ScryerCodebaseReadInput,
  ScryerCodebaseReadResult
> = async ({ input, project }) => {
  const result = await scanProjectTree(project, input)
  if ('ok' in result) {
    return result
  }
  return success({ result })
}
