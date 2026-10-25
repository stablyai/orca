import { globSync, readFileSync } from 'node:fs'
import { posix, join } from 'node:path'
import ts from 'typescript-api'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'
import { hasIndirectUnitInputs } from './ci-unit-indirect-inputs.mjs'
import {
  checkUnitInputOwnership,
  readUnitInputOwnership,
  unitInputSourceDigest
} from './ci-unit-input-ownership.mjs'
import { UNIT_SETUP_FILES } from './ci-unit-files.mjs'

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

export function buildUnitDependencyGraph(
  sources,
  workspace = { resolve: () => null },
  ownershipRecords = [],
  dependencyInputs = new Map()
) {
  const reverse = new Map()
  const opaque = new Set()
  const unresolved = new Set()
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
        unresolved.add(file)
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
        unresolved.add(file)
        continue
      }
      if (workspaceSource) {
        addConsumer(workspaceSource.manifest, file)
      }
    }
  }
  const dependencies = new Map()
  for (const [input, consumers] of reverse) {
    for (const consumer of consumers) {
      if (!dependencies.has(consumer)) {
        dependencies.set(consumer, new Set())
      }
      dependencies.get(consumer).add(input)
    }
  }
  const context = new Map(dependencyInputs)
  const runtime = unitConsumers(
    [
      'config/vitest.config.ts',
      'config/scripts/run-vitest.mjs',
      'config/scripts/ci-unit-dependency-graph.mjs',
      'config/scripts/ci-unit-input-ownership.mjs',
      'config/scripts/ci-unit-selection.mjs',
      ...UNIT_SETUP_FILES,
      ...[...sources.keys()].filter((file) => /^config\/tsconfig[^/]*\.json$/.test(file))
    ],
    dependencies
  )
  for (const file of runtime) {
    context.set(file, sources.get(file) ?? null)
  }
  const ownershipContextSha256 = unitInputSourceDigest(context)
  if (!Array.isArray(ownershipRecords) || !ownershipRecords.length) {
    return { reverse, opaque, ownershipContextSha256 }
  }
  const ownership = checkUnitInputOwnership(
    ownershipRecords,
    (file) => {
      const closure = unitConsumers([file], dependencies)
      return sources.has(file) && ![...closure].some((input) => unresolved.has(input))
        ? new Map([...closure].map((input) => [input, sources.get(input)]))
        : null
    },
    process.env,
    ownershipContextSha256
  )
  for (const [file, { inputs }] of ownership) {
    for (const input of inputs) {
      for (const source of input.endsWith('/') ? sources.keys() : [input]) {
        if (source.startsWith(input)) {
          addConsumer(source, file)
        }
      }
    }
    opaque.delete(file)
  }
  return {
    reverse,
    opaque,
    opaqueConsumers: unitConsumers(opaque, reverse, new Set(ownership.keys())),
    checkedInputOwners: [...ownership.keys()],
    ownershipContextSha256
  }
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
  let ownership = readUnitInputOwnership(root)
  const dependencyInputs = new Map()
  try {
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      dependencyInputs.set(file, readFileSync(join(root, file), 'utf8'))
    }
  } catch {
    ownership = []
  }
  return {
    ...buildUnitDependencyGraph(sources, workspace, ownership, dependencyInputs),
    files: new Set(sources.keys())
  }
}

export function unitConsumers(seeds, reverse, boundaries = new Set()) {
  const result = new Set([...seeds].filter((seed) => !boundaries.has(seed)))
  for (const file of result) {
    for (const consumer of reverse.get(file) ?? []) {
      if (!boundaries.has(consumer)) {
        result.add(consumer)
      }
    }
  }
  return result
}
