import { globSync, readFileSync } from 'node:fs'
import { posix, join } from 'node:path'
import ts from 'typescript-api'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'

const EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.js'
]
const INDIRECT_INPUT =
  /\b(?:readFile\w*|readdir\w*|glob\w*|spawn\w*|execFile\w*|execSync|runProcess\w*|fork|Worker)\b|\bimport\s*\(\s*[^'"\s]|\brequire\s*\(\s*[^'"\s]|\bnew\s+URL\s*\(/

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
    if (INDIRECT_INPUT.test(source) || file.startsWith('config/') || file.startsWith('tests/')) {
      opaque.add(file)
    }
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const workspaceSource = workspace.resolve(imported.fileName)
      const path = workspaceSource?.file ?? localPath(file, imported.fileName)
      if (path === null) {
        continue
      }
      let resolved
      for (const extension of EXTENSIONS) {
        const candidate = path + extension
        if (sources.has(candidate)) {
          resolved = candidate
          break
        }
      }
      if (!resolved) {
        opaque.add(file)
        continue
      }
      if (workspaceSource) {
        addConsumer(workspaceSource.manifest, file)
      }
      addConsumer(resolved, file)
    }
  }
  return { reverse, opaque }
}

export function collectUnitDependencyGraph(root = process.cwd()) {
  const files = globSync(
    [
      'src/**/*.{ts,tsx,js,mjs,cjs,json}',
      'config/**/*.{ts,tsx,js,mjs,cjs,json}',
      'tests/**/*.{ts,tsx,js,mjs,cjs,json}'
    ],
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
