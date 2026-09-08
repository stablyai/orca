import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RelaySessionSearchOwner } from './session-search-owner'
import { SessionSearchService } from '../main/ai-vault-search/session-search-service'
import { noAiVaultSearchIndexCoverage } from '../shared/ai-vault-search-coverage'
import { isolatedScanRoots } from '../main/ai-vault/session-scanner-test-fixtures'
import {
  userRecord,
  assistantRecord
} from '../main/ai-vault-search/session-search-transcript-fixtures'

const owners: RelaySessionSearchOwner[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('releases its lease without killing the scanner or extending ownership on status traffic', async () => {
  const { make } = await fixture()
  vi.useFakeTimers()
  const first = make()
  const second = make()
  await first.request('configure', { enabled: true, paused: true })
  await vi.advanceTimersByTimeAsync(4_000)
  await first.request('status', {})
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await second.request('configure', { enabled: false })).toMatchObject({
    enabled: false,
    applied: true
  })
  await expect(first.request('status', {})).rejects.toThrow('in use')
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'orca-ssh-search-'))
  directories.push(home)
  const directory = join(home, 'search')
  const roots = isolatedScanRoots(home)
  const make = () => {
    const owner = new RelaySessionSearchOwner(home, { directory, roots })
    owners.push(owner)
    return owner
  }
  return { home, directory, roots, make }
}

it('keeps consent off without creating an index, then searches a host-only deep marker across restart', async () => {
  const { directory, roots, make } = await fixture()
  const owner = make()
  expect(await owner.request('status', {})).toMatchObject({ enabled: false, available: true })
  expect(existsSync(directory)).toBe(false)
  await mkdir(roots.claudeProjectsDir, { recursive: true })
  await writeFile(
    join(roots.claudeProjectsDir, 'session.jsonl'),
    `${[
      userRecord(0, 'ordinary title'),
      assistantRecord(1, 'remoteonlyneedle'),
      userRecord(2, 'ordinary tail')
    ].join('\n')}\n`
  )
  await owner.request('configure', { enabled: true })
  const result = (await owner.request('query', { query: 'remoteonlyneedle' })) as {
    hits: unknown[]
  }
  expect(result.hits).toHaveLength(1)
  expect(existsSync(join(directory, 'index.sqlite'))).toBe(true)
  await owner.close()
  const replacement = make()
  expect(await replacement.request('status', {})).toMatchObject({ enabled: true, applied: true })
  expect(
    await replacement.request('query', { query: 'remoteonlyneedle', refresh: false })
  ).toMatchObject({ hits: [expect.anything()] })
  await rm(join(roots.claudeProjectsDir, 'session.jsonl'))
  expect(
    await replacement.request('query', { query: 'remoteonlyneedle', refresh: false })
  ).toMatchObject({ hits: [] })
  await replacement.request('configure', { enabled: false, clearIndex: true })
  expect(existsSync(join(directory, 'index.sqlite'))).toBe(false)
  expect(await replacement.request('query', { query: 'remoteonlyneedle' })).toMatchObject({
    hits: [],
    coverage: { enabled: false }
  })
})

it('refuses another owner and never acknowledges its clear; release permits the replacement', async () => {
  const { make } = await fixture()
  const first = make()
  const second = make()
  await first.request('configure', { enabled: true, paused: true })
  await expect(second.request('configure', { enabled: false, clearIndex: true })).rejects.toThrow(
    'in use'
  )
  expect(await first.request('status', {})).toMatchObject({ enabled: true, paused: true })
  await first.close()
  expect(await second.request('configure', { enabled: false, clearIndex: true })).toMatchObject({
    enabled: false,
    applied: true
  })
})

it('can clear and durably disable a corrupt previously enabled index', async () => {
  const { directory, make } = await fixture()
  const first = make()
  await first.request('configure', { enabled: true, paused: true })
  await first.close()
  await writeFile(join(directory, 'index.sqlite'), 'not a SQLite database')
  const replacement = make()
  await expect(
    replacement.request('configure', { enabled: false, clearIndex: true })
  ).resolves.toMatchObject({ enabled: false, applied: true })
  expect(existsSync(join(directory, 'index.sqlite'))).toBe(false)
  await replacement.close()
  await expect(make().request('status', {})).resolves.toMatchObject({ enabled: false })
})

it('retains an initialization failure in status until successful recovery', async () => {
  const { directory, make } = await fixture()
  const first = make()
  await first.request('configure', { enabled: true, paused: true })
  await first.close()
  await writeFile(join(directory, 'index.sqlite'), 'not a SQLite database')
  const replacement = make()
  await expect(replacement.request('query', { query: 'fixture' })).rejects.toThrow('not a database')
  await expect(replacement.request('status', {})).resolves.toMatchObject({
    enabled: true,
    applied: false,
    reason: expect.stringContaining('not a database')
  })
  await expect(replacement.request('configure', { clearIndex: true })).resolves.toMatchObject({
    enabled: true,
    applied: true
  })
})

it('keeps its lease through an invalid query instead of dropping the lock', async () => {
  const { make } = await fixture()
  const first = make()
  const second = make()
  await first.request('configure', { enabled: true, paused: true })

  await expect(first.request('query', { query: '   ' })).rejects.toThrow()

  await expect(second.request('configure', { enabled: false })).rejects.toThrow('in use')
  expect(await first.request('status', {})).toMatchObject({ enabled: true, applied: true })
})

it('still answers index-status for a policy it cannot vouch for, and a clear recovers it', async () => {
  const { directory, make } = await fixture()
  const first = make()
  await first.request('configure', { enabled: true })
  await first.close()
  await writeFile(
    join(directory, 'policy.json'),
    JSON.stringify({
      home: '/somewhere/else',
      version: 1,
      policy: { enabled: true, historyDays: null }
    })
  )
  const replacement = make()

  expect(await replacement.request('status', {})).toMatchObject({
    available: true,
    applied: false,
    reason: expect.stringContaining('must be reviewed')
  })
  await expect(replacement.request('query', { query: 'needle' })).rejects.toThrow(
    'must be reviewed'
  )
  expect(
    await replacement.request('configure', { enabled: false, clearIndex: true })
  ).toMatchObject({ enabled: false, applied: true })
})

it('records consent durably even when applying it to the index fails', async () => {
  const { directory, make } = await fixture()
  const first = make()
  await first.request('configure', { enabled: false })
  await first.close()
  await writeFile(join(directory, 'index.sqlite'), 'not a SQLite database')
  const replacement = make()

  await expect(replacement.request('configure', { enabled: true })).rejects.toThrow()
  await replacement.close()

  expect(await make().request('status', {})).toMatchObject({ enabled: true })
})

/**
 * A caller that cancels the instant the owner admits the request: the admission
 * check reads a live signal, everything after it reads the abort.
 */
function cancelledOnAdmission(): AbortSignal {
  const controller = new AbortController()
  let admitted = false
  Object.defineProperty(controller.signal, 'aborted', {
    configurable: true,
    get() {
      if (admitted) {
        return true
      }
      admitted = true
      controller.abort()
      return false
    }
  })
  return controller.signal
}

it('keeps its lease when the caller cancels and drops it when the service itself fails', async () => {
  const { directory, make } = await fixture()
  const first = make()
  await first.request('configure', { enabled: true, paused: true })
  await first.close()
  await writeFile(join(directory, 'index.sqlite'), 'not a SQLite database')
  const owner = make()
  const other = make()

  await expect(owner.request('query', { query: 'needle' }, cancelledOnAdmission())).rejects.toThrow(
    'not a database'
  )
  await expect(other.request('configure', { enabled: false })).rejects.toThrow('in use')

  await expect(owner.request('query', { query: 'needle' })).rejects.toThrow('not a database')
  await expect(other.request('configure', { enabled: false })).resolves.toMatchObject({
    enabled: false
  })
})

it('hands the lease over when the backfill it waited for cannot finish', async () => {
  const { make } = await fixture()
  vi.useFakeTimers()
  const first = make()
  const second = make()
  await first.request('configure', { enabled: true })
  vi.spyOn(SessionSearchService.prototype, 'coverage').mockReturnValue({
    ...noAiVaultSearchIndexCoverage(true),
    backfill: 'running'
  })
  vi.spyOn(SessionSearchService.prototype, 'ensureBackfill').mockRejectedValue(
    new Error('discovery failed')
  )

  await vi.advanceTimersByTimeAsync(5_000)

  await expect(second.request('status', {})).resolves.toMatchObject({ enabled: true })
})
