import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { SessionSearchStore } from './session-search-store'
import { stagedWriteUpdate } from './session-search-staged-write-test-fixture'
import { searchPresentSessionSources } from './session-search-source-presence'
import type { AiVaultSearchArgs, AiVaultSearchResult } from '../../shared/ai-vault-search-types'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0)) {
    await dispose()
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ss-presence-refill-'))
  const store = new SessionSearchStore(join(root, 'index.sqlite'))
  cleanup.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const name of ['first', 'second']) {
    const path = join(root, `${name}.jsonl`)
    await writeFile(path, 'synthetic fixture')
    const update = stagedWriteUpdate(`refillneedle ${name}`, 1)
    update.candidate.file.path = path
    update.session = { ...update.session!, filePath: path, sessionId: name }
    await store.apply(update)
  }
  const search = vi.fn((args: AiVaultSearchArgs) => store.search(args))
  const invalidate = vi.fn((paths: string[]) => paths.forEach((path) => store.removeFile(path)))
  return { root, store, search, invalidate }
}

it('refills a deleted top hit in the first query with a real index', async () => {
  const { store, search, invalidate } = await fixture()
  const args = { query: 'refillneedle', limit: 1 }
  const top = store.search(args).hits[0]
  await rm(top.filePath)
  const result = await searchPresentSessionSources(args, search, invalidate)
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0].filePath).not.toBe(top.filePath)
  expect(invalidate).toHaveBeenCalledWith([top.filePath])
  expect(store.search({ query: 'refillneedle' }).hits).toHaveLength(1)
  expect(result.omittedHits).toBeUndefined()
})

it('keeps an unreadable top hit instead of refilling past it or deleting it', async () => {
  const { store, search, invalidate } = await fixture()
  const args = { query: 'refillneedle', limit: 1 }
  const top = store.search(args).hits[0]
  const stat = transcriptFs.wslGatedStat
  const probe = vi
    .spyOn(transcriptFs, 'wslGatedStat')
    .mockImplementation((path, priority, signal) => {
      if (path === top.filePath) {
        return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      }
      return stat(path, priority, signal)
    })
  const result = await searchPresentSessionSources(args, search, invalidate)
  // Loss of contact is not evidence of absence: the hit stays, flagged.
  expect(result.hits.map((hit) => hit.filePath)).toEqual([top.filePath])
  expect(result.sourceUnavailableFiles).toBe(1)
  expect(invalidate).not.toHaveBeenCalled()
  expect(store.search({ query: 'refillneedle' }).hits).toHaveLength(2)
  expect(probe.mock.calls.filter(([path]) => path === top.filePath)).toHaveLength(1)
})

it('bounds refill and reports omissions when deleted hits consume the budget', async () => {
  const { store } = await fixture()
  const base = store.search({ query: 'refillneedle' })
  const source = base.hits[0]
  const hits = Array.from({ length: 100 }, (_, i) => ({
    ...source,
    filePath: join(source.filePath, String(i))
  }))
  vi.spyOn(transcriptFs, 'wslGatedStat').mockRejectedValue(
    Object.assign(new Error('gone'), { code: 'ENOENT' })
  )
  const search = vi.fn((args: AiVaultSearchArgs) => ({ ...base, hits: hits.slice(0, args.limit) }))
  const invalidate = vi.fn()
  const result = await searchPresentSessionSources(
    { query: 'refillneedle', limit: 1 },
    search,
    invalidate
  )
  expect(search).toHaveBeenCalledTimes(4)
  expect(search.mock.calls.map(([args]) => args.limit)).toEqual([1, 2, 4, 8])
  expect(result).toMatchObject({ hits: [], omittedHits: 8 })
  expect(result.sourceUnavailableFiles).toBeUndefined()
  expect(invalidate).toHaveBeenCalled()
})

it('does not invalidate a WSL source when its share reports ENOENT', async () => {
  const { store } = await fixture()
  const base = store.search({ query: 'refillneedle', limit: 1 })
  const filePath = String.raw`\\wsl.localhost\Ubuntu\home\fixture\missing.jsonl`
  const result: AiVaultSearchResult = { ...base, hits: [{ ...base.hits[0], filePath }] }
  vi.spyOn(transcriptFs, 'wslGatedStat').mockRejectedValue(
    Object.assign(new Error('share offline'), { code: 'ENOENT' })
  )
  const invalidate = vi.fn()
  expect(
    await searchPresentSessionSources({ query: 'refillneedle' }, () => result, invalidate)
  ).toMatchObject({ hits: [{ filePath }], sourceUnavailableFiles: 1 })
  expect(invalidate).not.toHaveBeenCalled()
})

it('does not invalidate or refill after cancellation during a presence probe', async () => {
  const { search, invalidate } = await fixture()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new AbortController()
  vi.spyOn(transcriptFs, 'wslGatedStat').mockImplementation(async () => {
    await held
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  const pending = searchPresentSessionSources(
    { query: 'refillneedle', limit: 1 },
    search,
    invalidate,
    controller.signal
  )
  controller.abort()
  release()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(invalidate).not.toHaveBeenCalled()
  expect(search).toHaveBeenCalledTimes(1)
})

it('validates sources through the common service, including a paused restart', async () => {
  const { SessionSearchService } = await import('./session-search-service')
  const { isolatedScanRoots } = await import('../ai-vault/session-scanner-test-fixtures')
  const { userRecord } = await import('./session-search-transcript-fixtures')
  const { mkdir } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'ss-service-presence-'))
  const roots = isolatedScanRoots(root)
  await mkdir(roots.claudeProjectsDir, { recursive: true })
  for (const name of ['first', 'second']) {
    await writeFile(
      join(roots.claudeProjectsDir, `${name}.jsonl`),
      `${userRecord(0, `servicepresenceneedle ${name}`)}\n`
    )
  }
  const databasePath = join(root, 'index.sqlite')
  let service = new SessionSearchService({ databasePath, enabled: true, historyDays: null })
  try {
    await service.ensureBackfill(roots)
    const args = { query: 'servicepresenceneedle', limit: 1, refresh: false }
    const first = await service.search(args, roots)
    expect(first.hits).toHaveLength(1)
    await rm(first.hits[0].filePath)
    const next = await service.search(args, roots)
    expect(next.hits).toHaveLength(1)
    expect(next.hits[0].filePath).not.toBe(first.hits[0].filePath)
    await service.close()
    await rm(next.hits[0].filePath)
    service = new SessionSearchService({
      databasePath,
      enabled: true,
      paused: true,
      historyDays: null
    })
    expect((await service.search(args, roots)).hits).toHaveLength(0)
    expect(service.coverage().indexing?.phase).toBe('paused')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
