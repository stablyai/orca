#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

const DEFAULT_OPTIONS = {
  rootDirs: 80,
  nestedDirsPerRoot: 20,
  filesPerNestedDir: 70,
  filesPerRoot: 20,
  windowSize: 80,
  passes: 80
}

function parseOptions() {
  const options = { ...DEFAULT_OPTIONS }
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(\d+)$/)
    if (!match) {
      continue
    }
    const [, key, value] = match
    if (key in options) {
      options[key] = Number(value)
    }
  }
  return options
}

function joinExplorerPath(parent, name) {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

function relativePath(worktreePath, path) {
  return path.slice(worktreePath.length + 1).replaceAll('\\', '/')
}

function addChild(dirCache, parentPath, child) {
  const current = dirCache[parentPath] ?? { children: [], loading: false }
  current.children.push(child)
  dirCache[parentPath] = current
}

function makeTreeFixture(options) {
  const worktreePath = '/repo'
  const dirCache = {
    [worktreePath]: { children: [], loading: false }
  }
  const expanded = new Set([worktreePath])
  const ignored = new Set()
  const canonicalPaths = []

  for (let rootIndex = 0; rootIndex < options.rootDirs; rootIndex++) {
    const rootName = `root-${String(rootIndex).padStart(3, '0')}`
    const rootPath = joinExplorerPath(worktreePath, rootName)
    expanded.add(rootPath)
    canonicalPaths.push(`${rootName}/`)
    addChild(dirCache, worktreePath, {
      depth: 0,
      isDirectory: true,
      name: rootName,
      path: rootPath,
      relativePath: relativePath(worktreePath, rootPath)
    })
    dirCache[rootPath] = { children: [], loading: false }

    for (let fileIndex = 0; fileIndex < options.filesPerRoot; fileIndex++) {
      const fileName = `root-file-${String(fileIndex).padStart(3, '0')}.ts`
      const filePath = joinExplorerPath(rootPath, fileName)
      const rel = relativePath(worktreePath, filePath)
      canonicalPaths.push(rel)
      addChild(dirCache, rootPath, {
        depth: 1,
        isDirectory: false,
        name: fileName,
        path: filePath,
        relativePath: rel
      })
    }

    for (let nestedIndex = 0; nestedIndex < options.nestedDirsPerRoot; nestedIndex++) {
      const nestedName = `nested-${String(nestedIndex).padStart(3, '0')}`
      const nestedPath = joinExplorerPath(rootPath, nestedName)
      const nestedRel = relativePath(worktreePath, nestedPath)
      expanded.add(nestedPath)
      canonicalPaths.push(`${nestedRel}/`)
      addChild(dirCache, rootPath, {
        depth: 1,
        isDirectory: true,
        name: nestedName,
        path: nestedPath,
        relativePath: nestedRel
      })
      dirCache[nestedPath] = { children: [], loading: false }

      for (let fileIndex = 0; fileIndex < options.filesPerNestedDir; fileIndex++) {
        const fileName = `file-${String(fileIndex).padStart(3, '0')}.tsx`
        const filePath = joinExplorerPath(nestedPath, fileName)
        const rel = relativePath(worktreePath, filePath)
        canonicalPaths.push(rel)
        if (fileIndex % 23 === 0) {
          ignored.add(rel)
        }
        addChild(dirCache, nestedPath, {
          depth: 2,
          isDirectory: false,
          name: fileName,
          path: filePath,
          relativePath: rel
        })
      }
    }
  }

  return { canonicalPaths, dirCache, expanded, ignored, worktreePath }
}

function flattenCurrent(worktreePath, dirCache, expanded) {
  const result = []
  const addChildren = (parentPath) => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const child of cached.children) {
      result.push(child)
      if (child.isDirectory && expanded.has(child.path)) {
        addChildren(child.path)
      }
    }
  }
  addChildren(worktreePath)
  return result
}

function getVisibleRows(flatRows, ignored, showGitIgnoredFiles) {
  if (showGitIgnoredFiles) {
    return flatRows
  }
  return flatRows.filter((row) => !ignored.has(row.relativePath))
}

function runLegacyCurrentPass(fixture, showGitIgnoredFiles) {
  const flatRows = flattenCurrent(fixture.worktreePath, fixture.dirCache, fixture.expanded)
  const rowsByPath = new Map(flatRows.map((row) => [row.path, row]))
  const visibleRows = getVisibleRows(flatRows, fixture.ignored, showGitIgnoredFiles)
  const visibleRowsByPath = new Map(visibleRows.map((row) => [row.path, row]))
  const orderedPaths = visibleRows.map((row) => row.path)
  return {
    flatCount: flatRows.length,
    orderedPathCount: orderedPaths.length,
    rowsByPath,
    visibleCount: visibleRows.length,
    visibleRowsByPath
  }
}

function collectIgnoredQueryRelativePaths(fixture) {
  const relativePaths = []
  const addChildren = (parentPath) => {
    const cached = fixture.dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      relativePaths.push(row.relativePath)
      if (row.isDirectory && fixture.expanded.has(row.path)) {
        addChildren(row.path)
      }
    }
  }
  addChildren(fixture.worktreePath)
  return relativePaths
}

function runDirectDirCacheProjectionPass(fixture, showGitIgnoredFiles) {
  const ignoredQueryRelativePaths = collectIgnoredQueryRelativePaths(fixture)
  const visibleRows = []
  const visibleRowsByPath = new Map()
  const addChildren = (parentPath) => {
    const cached = fixture.dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (!showGitIgnoredFiles && fixture.ignored.has(row.relativePath)) {
        continue
      }
      visibleRows.push(row)
      visibleRowsByPath.set(row.path, row)
      if (row.isDirectory && fixture.expanded.has(row.path)) {
        addChildren(row.path)
      }
    }
  }
  addChildren(fixture.worktreePath)
  const selectedPath = visibleRows.at(-1)?.path ?? null
  const selectedNode = selectedPath ? visibleRowsByPath.get(selectedPath) : null
  return {
    ignoredQueryPathCount: ignoredQueryRelativePaths.length,
    selectedPath: selectedNode?.path ?? null,
    visibleCount: visibleRows.length,
    visibleRowsByPath
  }
}

function buildIndexedProjection(fixture, showGitIgnoredFiles) {
  const rows = []
  const rowsByPath = new Map()
  const addChildren = (parentPath) => {
    const cached = fixture.dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const child of cached.children) {
      rowsByPath.set(child.path, child)
      if (showGitIgnoredFiles || !fixture.ignored.has(child.relativePath)) {
        rows.push(child)
      }
      if (child.isDirectory && fixture.expanded.has(child.path)) {
        addChildren(child.path)
      }
    }
  }
  addChildren(fixture.worktreePath)
  return {
    getVisibleCount: () => rows.length,
    getVisibleSlice: (start, end) => rows.slice(start, end + 1),
    getRowByPath: (path) => rowsByPath.get(path) ?? null
  }
}

function measure(label, passes, fn) {
  const durations = []
  let lastResult
  for (let index = 0; index < passes; index++) {
    const start = performance.now()
    lastResult = fn(index)
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  const sum = durations.reduce((total, value) => total + value, 0)
  return {
    label,
    maxMs: durations.at(-1),
    meanMs: sum / durations.length,
    minMs: durations[0],
    p50Ms: durations[Math.floor(durations.length * 0.5)],
    p95Ms: durations[Math.floor(durations.length * 0.95)],
    passes,
    sample: lastResult
  }
}

function round(value) {
  return Number(value.toFixed(3))
}

function printMeasurement(measurement) {
  console.log(
    `${measurement.label}: mean=${round(measurement.meanMs)}ms p50=${round(
      measurement.p50Ms
    )}ms p95=${round(measurement.p95Ms)}ms max=${round(measurement.maxMs)}ms`
  )
}

function main() {
  const options = parseOptions()
  const fixture = makeTreeFixture(options)
  const totalRows = fixture.canonicalPaths.length
  console.log(
    `fixture: canonicalPaths=${totalRows} roots=${options.rootDirs} nestedDirsPerRoot=${options.nestedDirsPerRoot} filesPerNestedDir=${options.filesPerNestedDir}`
  )

  const legacyCurrent = measure('legacy-current-full-flatten+maps', options.passes, () =>
    runLegacyCurrentPass(fixture, false)
  )
  printMeasurement(legacyCurrent)

  const directProjection = measure('direct-dir-cache-row-projection', options.passes, () =>
    runDirectDirCacheProjectionPass(fixture, false)
  )
  printMeasurement(directProjection)

  const projectionBuild = measure('indexed-projection-rebuild', options.passes, () =>
    buildIndexedProjection(fixture, false)
  )
  printMeasurement(projectionBuild)

  const projection = buildIndexedProjection(fixture, false)
  const indexedSlice = measure('indexed-visible-window-slice', options.passes, (index) => {
    const visibleCount = projection.getVisibleCount()
    const maxStart = Math.max(0, visibleCount - options.windowSize)
    const start = maxStart === 0 ? 0 : (index * 97) % maxStart
    const rows = projection.getVisibleSlice(start, start + options.windowSize - 1)
    const selected = projection.getRowByPath(rows.at(-1)?.path ?? '')
    return { selected: selected?.path ?? null, visibleWindowCount: rows.length }
  })
  printMeasurement(indexedSlice)

  console.log(
    JSON.stringify(
      {
        fixture: {
          canonicalPaths: totalRows,
          expandedDirs: fixture.expanded.size,
          ignoredPaths: fixture.ignored.size
        },
        indexedSlice,
        legacyCurrent,
        directProjection,
        projectionBuild
      },
      null,
      2
    )
  )
}

main()
