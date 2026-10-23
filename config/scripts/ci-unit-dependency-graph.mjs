import { globSync, readFileSync } from 'node:fs'
import { posix, join } from 'node:path'
import ts from 'typescript-api'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'
import { hasIndirectUnitInputs } from './ci-unit-indirect-inputs.mjs'

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'mjs', 'js', 'jsx', 'cjs', 'json']
const RESOLUTION_SUFFIXES = [
  '',
  ...SOURCE_EXTENSIONS.map((extension) => `.${extension}`),
  ...SOURCE_EXTENSIONS.map((extension) => `/index.${extension}`)
]

function localPath(file, specifier) {
  if (specifier.startsWith('.')) {
    return posix.join(posix.dirname(file), specifier)
  }
  if (specifier.startsWith('@renderer/')) {
    return `src/renderer/src/${specifier.slice(10)}`
  }
  if (specifier.startsWith('@/')) {
    return `src/renderer/src/${specifier.slice(2)}`
  }
  return null
}

export function buildUnitDependencyGraph(sources, workspace = { resolve: () => null }) {
  const reverse = new Map()
  const opaque = new Set()
  function addConsumer(input, file) {
    if (!reverse.has(input)) {
      reverse.set(input, new Set())
    }
    reverse.get(input).add(file)
  }
  for (const [file, source] of sources) {
    const imports = ts.preProcessFile(source, true, true).importedFiles
    if (
      file.startsWith('config/') ||
      file.startsWith('tests/') ||
      hasIndirectUnitInputs(file, source, imports)
    ) {
      opaque.add(file)
    }
    for (const imported of imports) {
      if (imported.fileName === 'module' || imported.fileName === 'node:module') {
        opaque.add(file)
      }
      const workspaceSource = workspace.resolve(imported.fileName)
      const path = workspaceSource?.file ?? localPath(file, imported.fileName)
      if (path === null) {
        continue
      }
      const candidates = RESOLUTION_SUFFIXES.map((suffix) => path + suffix)
      if (/\.(?:[mc]?js|jsx)$/.test(path)) {
        candidates.push(path.replace(/js(x?)$/, 'ts$1'))
        if (path.endsWith('.js')) {
          candidates.push(`${path.slice(0, -3)}.tsx`)
        }
      }
      if (sources.has(`${path}/package.json`)) {
        opaque.add(file)
      }
      let resolved = false
      // Resolution differs across runtimes; retain every plausible source consumer.
      for (const candidate of candidates) {
        if (sources.has(candidate)) {
          addConsumer(candidate, file)
          resolved = true
        }
      }
      if (!resolved) {
        opaque.add(file)
        continue
      }
      if (workspaceSource) {
        addConsumer(workspaceSource.manifest, file)
      }
    }
  }
  return { reverse, opaque }
}

export function collectUnitDependencyGraph(root = process.cwd()) {
  const files = globSync(
    ['src', 'config', 'tests'].map(
      (directory) => `${directory}/**/*.{${SOURCE_EXTENSIONS.join(',')}}`
    ),
    { cwd: root, exclude: ['**/node_modules/**', '**/dist/**'] }
  )
  const sources = new Map(
    files.map((file) => [file.replaceAll('\\', '/'), readFileSync(join(root, file), 'utf8')])
  )
  const workspace = createWorkspaceSourceResolver(root)
  return { ...buildUnitDependencyGraph(sources, workspace), files: new Set(sources.keys()) }
}

export function unitConsumers(seeds, reverse) {
  const result = new Set(seeds)
  for (const file of result) {
    for (const consumer of reverse.get(file) ?? []) {
      result.add(consumer)
    }
  }
  return result
}
