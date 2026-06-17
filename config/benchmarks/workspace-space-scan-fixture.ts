import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { Repo } from '../../src/shared/types'
import { analyzeWorkspaceSpace } from '../../src/main/workspace-space-analysis'
import { stats, type TimingStats } from './non-terminal-benchmark-stats'

const SCAN_ITERATIONS = 3
const SCAN_WARMUP_ITERATIONS = 1

export type WorkspaceSpaceScanResult = {
  scenario: string
  repos: number
  worktrees: number
  topLevelItems: number
  rawProgressEvents: number
  duProcessesPerIteration: number
  stats: TimingStats
}

export type WorkspaceSpaceFixture = {
  root: string
  repos: Repo[]
}

type DuCountReader = () => Promise<number>

const execFileAsync = promisify(execFile)

function makeRepo(id: string, repoPath: string, index: number): Repo {
  return {
    id,
    path: repoPath,
    displayName: `Folder ${index}`,
    badgeColor: 'blue',
    addedAt: 1_700_000_000_000 + index,
    kind: 'folder'
  } as Repo
}

export async function createWorkspaceSpaceFixture(
  repoCount: number
): Promise<WorkspaceSpaceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-space-bench-'))
  const repos: Repo[] = []
  for (let repoIndex = 0; repoIndex < repoCount; repoIndex += 1) {
    const repoPath = path.join(root, `folder-${repoIndex}`)
    await mkdir(repoPath, { recursive: true })
    repos.push(makeRepo(`folder-repo-${repoIndex}`, repoPath, repoIndex))
    await populateWorkspaceFolder(repoPath, repoIndex)
  }
  return { root, repos }
}

async function populateWorkspaceFolder(repoPath: string, repoIndex: number): Promise<void> {
  for (let dirIndex = 0; dirIndex < 8; dirIndex += 1) {
    const dirPath = path.join(repoPath, `top-${dirIndex}`)
    await mkdir(dirPath)
    for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
      await writeFile(
        path.join(dirPath, `file-${fileIndex}.txt`),
        `repo ${repoIndex} dir ${dirIndex} file ${fileIndex}\n`.repeat(16)
      )
    }
  }
  for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
    await writeFile(path.join(repoPath, `root-${fileIndex}.txt`), 'root file\n'.repeat(16))
  }
}

function makeStore(repos: Repo[]): Parameters<typeof analyzeWorkspaceSpace>[0] {
  return {
    getRepos: () => repos,
    getWorktreeMeta: () => ({})
  } as Parameters<typeof analyzeWorkspaceSpace>[0]
}

async function resolveRealDuPath(): Promise<string> {
  if (process.platform === 'win32') {
    return 'du'
  }
  const { stdout } = await execFileAsync('which', ['du'])
  return stdout.trim() || 'du'
}

async function createDuCountShim(): Promise<{ shimDir: string; countFile: string }> {
  const shimDir = await mkdtemp(path.join(tmpdir(), 'orca-du-count-shim-'))
  const countFile = path.join(shimDir, 'count.txt')
  await writeFile(countFile, '')
  if (process.platform === 'win32') {
    await writeFile(
      path.join(shimDir, 'du.cmd'),
      `@echo off\r\necho 1>> "%ORCA_DU_COUNT_FILE%"\r\n"%ORCA_REAL_DU%" %*\r\n`
    )
  } else {
    const shimPath = path.join(shimDir, 'du')
    await writeFile(
      shimPath,
      `#!/bin/sh\nprintf '1\\n' >> "$ORCA_DU_COUNT_FILE"\nexec "$ORCA_REAL_DU" "$@"\n`
    )
    await chmod(shimPath, 0o755)
  }
  return { shimDir, countFile }
}

async function readDuProcessCount(countFile: string): Promise<number> {
  const countText = await readFile(countFile, 'utf8').catch(() => '')
  return countText.split('\n').filter(Boolean).length
}

async function withDuCountShim<T>(fn: (readCount: DuCountReader) => Promise<T>): Promise<T> {
  if (process.platform === 'win32') {
    return fn(async () => 0)
  }
  const realDuPath = await resolveRealDuPath()
  const shim = await createDuCountShim()
  const previousPath = process.env.PATH
  const previousRealDu = process.env.ORCA_REAL_DU
  const previousCountFile = process.env.ORCA_DU_COUNT_FILE
  process.env.PATH = `${shim.shimDir}${path.delimiter}${previousPath ?? ''}`
  process.env.ORCA_REAL_DU = realDuPath
  process.env.ORCA_DU_COUNT_FILE = shim.countFile
  try {
    return await fn(() => readDuProcessCount(shim.countFile))
  } finally {
    restoreEnv('PATH', previousPath)
    restoreEnv('ORCA_REAL_DU', previousRealDu)
    restoreEnv('ORCA_DU_COUNT_FILE', previousCountFile)
    await rm(shim.shimDir, { recursive: true, force: true })
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

export async function measureWorkspaceSpaceScan(
  fixture: WorkspaceSpaceFixture
): Promise<WorkspaceSpaceScanResult> {
  return withDuCountShim(async (readDuCount) => {
    const wallSamples: number[] = []
    const duSamples: number[] = []
    let worktrees = 0
    let topLevelItems = 0
    let rawProgressEvents = 0
    for (let index = 0; index < SCAN_WARMUP_ITERATIONS; index += 1) {
      await analyzeWorkspaceSpace(makeStore(fixture.repos))
    }
    for (let iteration = 0; iteration < SCAN_ITERATIONS; iteration += 1) {
      let progressEvents = 0
      const before = await readDuCount()
      const startedAt = performance.now()
      const analysis = await analyzeWorkspaceSpace(makeStore(fixture.repos), {
        onProgress: () => {
          progressEvents += 1
        }
      })
      wallSamples.push(performance.now() - startedAt)
      const after = await readDuCount()
      duSamples.push(after - before)
      worktrees = analysis.worktreeCount
      topLevelItems = analysis.worktrees.reduce((total, row) => total + row.topLevelItems.length, 0)
      rawProgressEvents = Math.max(rawProgressEvents, progressEvents)
    }
    return {
      scenario: `${fixture.repos.length} folder repos, 8 top dirs + 4 root files each`,
      repos: fixture.repos.length,
      worktrees,
      topLevelItems,
      rawProgressEvents,
      duProcessesPerIteration: Math.max(...duSamples),
      stats: stats(wallSamples)
    }
  })
}
