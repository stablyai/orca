#!/usr/bin/env node
// Benchmarks four renderer projections that scaled worse than linearly with user data, each on a
// path that reruns per keystroke or per store write.
//
// Scenarios 1, 3 and 4 time the production export against a hand-written reproduction of the
// pre-change shape and assert both agree first. Scenario 2 is MODELLED on both sides: the
// projection lives inside the `useTabGroupItemProjections` React hook and cannot be imported
// without a renderer, so it reproduces the before/after loops rather than driving production.
import { spawnSync } from 'node:child_process'
import { transformSync } from 'esbuild'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import nodeModule from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

const ROOT = path.resolve(import.meta.dirname, '../..')
const RENDERER = path.join(ROOT, 'src/renderer/src')

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL) {
      return nextResolve(specifier, context)
    }
    const candidates = specifier.startsWith('@/')
      ? ['.ts', '.tsx', '/index.ts', '/index.tsx', ''].map(
          (suffix) => path.join(RENDERER, specifier.slice(2)) + suffix
        )
      : specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)
        ? ['.ts', '.tsx'].map((suffix) =>
            fileURLToPath(new URL(specifier + suffix, context.parentURL))
          )
        : []
    const resolved = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    return resolved
      ? { url: pathToFileURL(resolved).href, shortCircuit: true }
      : nextResolve(specifier, context)
  },
  // Node strips types from .ts but not .tsx; the sidebar row model transitively imports icons.
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      const { code } = transformSync(source, { loader: 'tsx', format: 'esm', jsx: 'automatic' })
      return { format: 'module', source: code, shortCircuit: true }
    }
    if (url.endsWith('.json') && !url.includes('/node_modules/')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return { format: 'module', source: `export default ${source}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  }
})

const importRenderer = (relativePath) =>
  import(pathToFileURL(path.join(RENDERER, relativePath)).href)

function envInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return value
}

const KEYSTROKES = envInt('ORCA_QUADRATIC_BENCH_KEYSTROKES', 12)
const WORKTREES = envInt('ORCA_QUADRATIC_BENCH_WORKTREES', 300)
const TABS = envInt('ORCA_QUADRATIC_BENCH_TABS', 60)
const OPEN_FILES = envInt('ORCA_QUADRATIC_BENCH_OPEN_FILES', 120)
const CHANGED_FILES = envInt('ORCA_QUADRATIC_BENCH_CHANGED_FILES', 5000)
const SIDEBAR_ROWS = envInt('ORCA_QUADRATIC_BENCH_SIDEBAR_ROWS', 600)
const SIDEBAR_REPOS = envInt('ORCA_QUADRATIC_BENCH_SIDEBAR_REPOS', 80)
if (SIDEBAR_REPOS > SIDEBAR_ROWS) {
  throw new Error(
    'ORCA_QUADRATIC_BENCH_SIDEBAR_REPOS must not exceed ORCA_QUADRATIC_BENCH_SIDEBAR_ROWS'
  )
}

function timeRounds(run, rounds = 7) {
  run()
  const samples = Array.from({ length: rounds }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).sort((left, right) => left - right)
  return samples[Math.floor(rounds / 2)]
}

function repeat(times, run) {
  return () => {
    let last
    for (let round = 0; round < times; round += 1) {
      last = run()
    }
    return last
  }
}

const results = []
function compare({ label, scale, drives, before, after }) {
  if (JSON.stringify(before()) !== JSON.stringify(after())) {
    throw new Error(`${label}: baseline disagreed with the indexed shape`)
  }
  results.push({ label, scale, drives, beforeMs: timeRounds(before), afterMs: timeRounds(after) })
}

// ------------------------------------------------- 1. workspace board search index

const { buildWorkspaceBoardPaletteDocuments, matchWorkspaceBoardWorktrees } = await importRenderer(
  'components/sidebar/workspace-kanban-search.ts'
)

const repoMap = new Map([
  ['repo-1', { id: 'repo-1', name: 'orca', path: '/tmp/orca', branch: 'main' }]
])
const boardWorktrees = Array.from({ length: WORKTREES }, (_, index) => ({
  id: `repo-1::/tmp/worktree-${index}`,
  repoId: 'repo-1',
  path: `/tmp/worktree-${index}`,
  branch: `feature/search-target-${index}`,
  title: `Workspace ${index} search target`,
  isMain: false
}))
const queries = Array.from({ length: KEYSTROKES }, (_, index) => 'search'.slice(0, (index % 6) + 1))
const matchAll = (documents) =>
  queries.map((query) => [
    ...matchWorkspaceBoardWorktrees({ worktrees: boardWorktrees, query, repoMap, documents })
  ])

compare({
  label: 'workspace board filter (per keystroke burst)',
  scale: `${WORKTREES} worktrees x ${KEYSTROKES} keystrokes`,
  drives: 'production',
  // Omitting `documents` is the pre-change shape: the index is rebuilt inside every match.
  before: () => matchAll(undefined),
  // The hook memoizes the index on [worktrees, repoMap]; only the match reruns per keystroke.
  after: () => matchAll(buildWorkspaceBoardPaletteDocuments({ worktrees: boardWorktrees, repoMap }))
})

// ------------------------------------------------- 2. tab-group projections (modelled)

const groupTabs = Array.from({ length: TABS }, (_, index) => ({
  id: `tab-${index}`,
  entityId: `entity-${index}`,
  contentType: index % 3 === 0 ? 'editor' : 'terminal'
}))
const openFiles = Array.from({ length: OPEN_FILES }, (_, index) => ({
  id: `entity-${index}`,
  path: `/tmp/file-${index}.ts`
}))
const tabOrder = groupTabs.map((tab) => tab.id)
// Production memoizes each index on its own source list, so a unified-tab write reuses it.
const openFileById = new Map(openFiles.map((item) => [item.id, item]))
const groupTabById = new Map(groupTabs.map((item) => [item.id, item]))

function tabProjections(findOpenFile, findGroupTab) {
  const editorItems = groupTabs
    .filter((item) => item.contentType === 'editor')
    .map((item) => findOpenFile(item.entityId))
    .filter((file) => file !== undefined)
  const order = tabOrder.map((itemId) => findGroupTab(itemId)?.entityId ?? itemId)
  return [editorItems, order]
}

compare({
  label: 'tab-group projections (per unified-tab write)',
  scale: `${TABS} tabs x ${OPEN_FILES} open files`,
  drives: 'modelled',
  before: repeat(200, () =>
    tabProjections(
      (id) => openFiles.find((candidate) => candidate.id === id),
      (id) => groupTabs.find((candidate) => candidate.id === id)
    )
  ),
  after: repeat(200, () =>
    tabProjections(
      (id) => openFileById.get(id),
      (id) => groupTabById.get(id)
    )
  )
})

// ------------------------------------------------- 3. source-control tree build

const { buildSourceControlTree } = await importRenderer(
  'components/right-sidebar/source-control-tree.ts'
)
const { normalizeRelativePath } = await importRenderer('lib/path.ts')
const { splitPathSegments } = await importRenderer('components/right-sidebar/path-tree.ts')
const { compareFileNames } = await import(
  pathToFileURL(path.join(ROOT, 'src/shared/file-name-sort.ts')).href
)

const changedEntries = Array.from({ length: CHANGED_FILES }, (_, index) => ({
  path: `src/area-${index % 20}/module-${index % 60}/nested/deep/part-${index % 7}/file-${index}.ts`
}))

// Pre-change `buildSourceControlTree`: identical except each ancestor path is re-joined.
function buildSourceControlTreeBefore(area, entries) {
  const makeDirectory = (dirPath, name, depth) => ({
    type: 'directory',
    key: `dir::${area}::${dirPath}`,
    name,
    path: dirPath,
    area,
    depth,
    fileCount: 0,
    children: [],
    directoryChildren: new Map()
  })
  const root = makeDirectory('', '', -1)
  for (const entry of entries) {
    const normalizedPath = normalizeRelativePath(entry.path)
    const segments = splitPathSegments(normalizedPath)
    if (segments.length === 0) {
      continue
    }
    let parent = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]
      const dirPath = segments.slice(0, index + 1).join('/')
      let dir = parent.directoryChildren.get(name)
      if (!dir) {
        dir = makeDirectory(dirPath, name, index)
        parent.directoryChildren.set(name, dir)
        parent.children.push(dir)
      }
      parent = dir
    }
    parent.children.push({
      type: 'file',
      key: `${area}::${entry.path}`,
      name: segments.at(-1),
      path: normalizedPath,
      entry,
      area,
      depth: segments.length - 1
    })
  }
  const finalize = (node) => {
    const directories = node.children.filter((child) => child.type === 'directory').map(finalize)
    const files = node.children.filter((child) => child.type === 'file')
    directories.sort((a, b) => compareFileNames(a.name, b.name))
    files.sort((a, b) => compareFileNames(a.entry.path, b.entry.path))
    const { directoryChildren: _, ...rest } = node
    return {
      ...rest,
      fileCount: files.length + directories.reduce((count, dir) => count + dir.fileCount, 0),
      children: [...directories, ...files]
    }
  }
  return finalize(root).children
}

compare({
  label: 'source-control tree build (per filter keystroke)',
  scale: `${CHANGED_FILES} changed files`,
  drives: 'production',
  before: () => buildSourceControlTreeBefore('unstaged', changedEntries),
  after: () => buildSourceControlTree('unstaged', changedEntries)
})

// ------------------------------------------------- 4. sidebar header boundaries

const { getRepoHeaderSectionEndByRepoId } = await importRenderer(
  'components/sidebar/worktree-header-section-boundaries.ts'
)
const { estimateRenderRowSize } = await importRenderer(
  'components/sidebar/worktree-list/viewport/virtual-rows.ts'
)

const headerRowIndexes = new Set(
  Array.from({ length: SIDEBAR_REPOS }, (_, repo) =>
    Math.floor((repo * SIDEBAR_ROWS) / SIDEBAR_REPOS)
  )
)
const sidebarRows = Array.from({ length: SIDEBAR_ROWS }, (_, index) =>
  headerRowIndexes.has(index)
    ? {
        type: 'header',
        key: `repo:${index}`,
        label: '',
        count: 0,
        tone: '',
        repo: { id: `repo-${index}` }
      }
    : { type: 'item', rowKey: `wt:${index}`, sectionKey: '', depth: 0, groupDepth: 0 }
)
const headerRepoIds = sidebarRows.filter((row) => row.type === 'header').map((row) => row.repo.id)
const boundaryArgs = {
  rows: sidebarRows,
  firstHeaderIndex: 0,
  // What `getSidebarOrderedRepoHeaderIdsByBucket` yields for repos outside any project group.
  sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', headerRepoIds]]),
  repoHeaderBucketByRepoId: new Map(headerRepoIds.map((id) => [id, 'ungrouped']))
}

// Pre-change `getRepoHeaderSectionEndByRepoId`: a findIndex and an indexOf per header row.
function getRepoHeaderSectionEndByRepoIdBefore(args) {
  const rowStarts = []
  let offset = 0
  for (let index = 0; index < args.rows.length; index += 1) {
    rowStarts[index] = offset
    offset += estimateRenderRowSize(args.rows, index, args.firstHeaderIndex, null)
  }
  rowStarts[args.rows.length] = offset
  const sectionEndByRepoId = new Map()
  for (let index = 0; index < args.rows.length; index += 1) {
    const row = args.rows[index]
    const repoId = row?.type === 'header' ? row.repo?.id : undefined
    if (!repoId) {
      continue
    }
    const bucketKey = args.repoHeaderBucketByRepoId.get(repoId)
    const bucketRepoIds = bucketKey ? args.sidebarRepoHeaderIdsByBucket.get(bucketKey) : undefined
    const bucketIndex = bucketRepoIds?.indexOf(repoId) ?? -1
    const nextRepoId = bucketIndex >= 0 ? bucketRepoIds?.[bucketIndex + 1] : undefined
    let endIndex = -1
    if (nextRepoId) {
      endIndex = args.rows.findIndex((r) => r.type === 'header' && r.repo?.id === nextRepoId)
    } else {
      endIndex = args.rows.length
      for (let next = index + 1; next < args.rows.length; next += 1) {
        if (args.rows[next]?.type === 'header' || args.rows[next]?.type === 'host-header') {
          endIndex = next
          break
        }
      }
    }
    sectionEndByRepoId.set(
      repoId,
      rowStarts[endIndex >= 0 ? endIndex : args.rows.length] ?? rowStarts[args.rows.length] ?? 0
    )
  }
  return sectionEndByRepoId
}

compare({
  label: 'sidebar header boundaries (per row-model rebuild)',
  scale: `${SIDEBAR_REPOS} repos x ${SIDEBAR_ROWS} rows`,
  drives: 'production',
  before: repeat(50, () => [...getRepoHeaderSectionEndByRepoIdBefore(boundaryArgs)]),
  after: repeat(50, () => [...getRepoHeaderSectionEndByRepoId(boundaryArgs)])
})

// -------------------------------------------------

console.log('Renderer quadratic-scan removals\n')
console.log('| projection | drives | scale | before | after | |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const row of results) {
  console.log(
    `| ${row.label} | ${row.drives} | ${row.scale} | ${row.beforeMs.toFixed(2)} ms | ${row.afterMs.toFixed(2)} ms | ${(row.beforeMs / row.afterMs).toFixed(1)}x |`
  )
}
