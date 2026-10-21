import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  persistClaudeUsageSourceCache,
  readClaudeUsageSourceCache,
  writeClaudeUsageSourceCache,
  type ClaudeUsageLoadedSourceCache
} from './persisted-source-cache'
import { scanClaudeUsageFiles } from './scanner'
import { sealUsageCacheJson } from '../usage/usage-cache-json-integrity'
import * as sourceCacheWriter from '../usage/usage-source-cache-file'

const { discovered } = vi.hoisted(() => {
  const paths: string[] = []
  return { discovered: { paths } }
})
vi.mock('./transcript-file-discovery', () => ({
  listClaudeTranscriptFiles: async () => discovered.paths
}))

let directory: string
let owner: string
let fork: string
let sourcePath: string

function ref() {
  return { path: sourcePath, schemaVersion: 7, worktreeFingerprint: '[]', reuse: true }
}

function row(input: number, key = 'shared'): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'session',
    requestId: key,
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd: directory,
    message: { id: key, usage: { input_tokens: input, output_tokens: 2 } }
  })}\n`
}

function contents(input: number, key = 'shared'): string {
  return `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n${row(input, key)}`
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return
  }
  for (const child of Object.values(value)) {
    freeze(child)
  }
  Object.freeze(value)
}

async function scanAndPersist(previous: ClaudeUsageLoadedSourceCache) {
  const result = await scanClaudeUsageFiles(
    [],
    previous.sources,
    undefined,
    [],
    previous.verifiedSources
  )
  await persistClaudeUsageSourceCache(ref(), result.processedFiles, previous)
  return result
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-retain-source-'))
  owner = join(directory, 'owner.jsonl')
  fork = join(directory, 'fork.jsonl')
  sourcePath = join(directory, 'sources.json')
  discovered.paths = [owner, fork]
  await writeFile(owner, contents(100))
  await writeFile(fork, contents(100))
  const initial = await scanClaudeUsageFiles([], [], undefined, [])
  expect(initial.processedFiles[1].hasDeferredClaims).toBe(true)
  await writeClaudeUsageSourceCache(ref(), initial.processedFiles)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('retains the exact verified sidecar for unchanged frozen files without durable writes', async () => {
  const text = await readFile(sourcePath, 'utf8')
  const previous = await readClaudeUsageSourceCache(ref())
  const before = JSON.stringify(previous.sources)
  freeze(previous.sources)
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  const result = await scanAndPersist(previous)

  expect(result.processedFiles).toEqual(previous.sources)
  expect(result.processedFiles[0]).toBe(previous.sources[0])
  expect(result.processedFiles[1]).toBe(previous.sources[1])
  expect(JSON.stringify(previous.sources)).toBe(before)
  expect(write).not.toHaveBeenCalled()
  expect(await readFile(sourcePath, 'utf8')).toBe(text)
})

it.each(['append', 'rewrite', 'new', 'delete', 'reorder', 'reclaim', 'deferred'] as const)(
  'writes the new generation after %s without changing frozen previous files',
  async (change) => {
    const previous = await readClaudeUsageSourceCache(ref())
    const before = JSON.stringify(previous.sources)
    freeze(previous.sources)
    if (change === 'append') {
      await appendFile(owner, row(150))
    } else if (change === 'rewrite') {
      await writeFile(owner, contents(75))
    } else if (change === 'new') {
      const added = join(directory, 'new.jsonl')
      await writeFile(added, contents(50, 'new'))
      discovered.paths.push(added)
    } else if (change === 'delete') {
      discovered.paths = [owner]
    } else if (change === 'reorder') {
      discovered.paths.reverse()
    } else if (change === 'reclaim') {
      discovered.paths = [fork]
    } else {
      await appendFile(fork, row(200))
    }
    const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

    const result = await scanAndPersist(previous)

    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(previous.sources)).toBe(before)
    expect((await readClaudeUsageSourceCache(ref())).sources).toEqual(result.processedFiles)
    if (change === 'reclaim') {
      expect(result.processedFiles[0].hasDeferredClaims).toBe(false)
      expect(result.sessions[0].totalInputTokens).toBe(100)
    }
  }
)

it('writes a schema7 generation even when a legacy scan returns identical file references', async () => {
  const saved = await readClaudeUsageSourceCache(ref())
  await writeFile(
    sourcePath,
    JSON.stringify({ schemaVersion: 6, worktreeFingerprint: '[]', sources: saved.sources })
  )
  const previous = await readClaudeUsageSourceCache(ref())
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  const result = await scanAndPersist(previous)

  expect(result.processedFiles[0]).toBe(previous.sources[0])
  expect(write).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(sourcePath, 'utf8')).schemaVersion).toBe(7)
})

it('does not skip a write for cloned files with unchanged values', async () => {
  const previous = await readClaudeUsageSourceCache(ref())
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  await persistClaudeUsageSourceCache(ref(), structuredClone(previous.sources), previous)

  expect(write).toHaveBeenCalledTimes(1)
})

it('retains verified tiny files whose source envelope protects their complete rollups', async () => {
  await writeFile(owner, row(100))
  await writeFile(fork, row(100))
  const initial = await scanClaudeUsageFiles([], [], undefined, [])
  expect(initial.processedFiles.every((file) => file.parseResumeState === null)).toBe(true)
  await writeClaudeUsageSourceCache(ref(), initial.processedFiles)
  const previous = await readClaudeUsageSourceCache(ref())
  freeze(previous.sources)
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  await scanAndPersist(previous)

  expect(write).not.toHaveBeenCalled()
})

it('persists source repairs even when every surviving file reference is unchanged', async () => {
  const saved = JSON.parse(await readFile(sourcePath, 'utf8'))
  delete saved.usageIntegrity
  saved.sources.push({ ...saved.sources[0], path: 'invalid', sessions: null })
  await writeFile(sourcePath, sealUsageCacheJson(JSON.stringify(saved), 'claude-usage-sources-v1'))
  discovered.paths = [owner]
  const previous = await readClaudeUsageSourceCache(ref())
  expect(previous.sources).toHaveLength(1)
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  const result = await scanAndPersist(previous)

  expect(result.processedFiles[0]).toBe(previous.sources[0])
  expect(write).toHaveBeenCalledTimes(1)
  expect((await readClaudeUsageSourceCache(ref())).sources).toEqual(result.processedFiles)
})

it.each(['path', 'schema', 'fingerprint', 'reuse'] as const)(
  'does not retain a sidecar after its request %s changes',
  async (change) => {
    const sourceRef = ref()
    const previous = await readClaudeUsageSourceCache(sourceRef)
    if (change === 'path') {
      sourceRef.path = join(directory, 'other-sources.json')
    } else if (change === 'schema') {
      sourceRef.schemaVersion = 6
    } else if (change === 'fingerprint') {
      sourceRef.worktreeFingerprint = '["other-worktree"]'
    } else {
      sourceRef.reuse = false
    }
    const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

    await persistClaudeUsageSourceCache(sourceRef, previous.sources, previous)

    expect(write).toHaveBeenCalledTimes(1)
  }
)

it('writes changed attribution after an incompatible fingerprint starts cold', async () => {
  const sourceRef = { ...ref(), worktreeFingerprint: '["worktree"]' }
  const previous = await readClaudeUsageSourceCache(sourceRef)
  const worktrees = [
    { repoId: 'repo', worktreeId: 'tree', path: directory, displayName: 'Project' }
  ]
  const write = vi.spyOn(sourceCacheWriter, 'writeUsageSourceCacheData')

  const result = await scanClaudeUsageFiles(worktrees, previous.sources, undefined, [])
  await persistClaudeUsageSourceCache(sourceRef, result.processedFiles, previous)

  expect(previous.sources).toEqual([])
  expect(result.sessions[0].primaryWorktreeId).toBe('tree')
  expect(write).toHaveBeenCalledTimes(1)
})
