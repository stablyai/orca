import type * as TranscriptFs from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { registerTranscriptConsumer } from '../../ai-vault/transcripts/session-transcript-consumers'
import { physicalSessionCandidates } from '../../ai-vault/session-scanner-types'
import { isolatedScanRoots } from '../../ai-vault/scanner-fixtures/session-scanner-test-fixtures'
import {
  discoverSessionSearchCandidates,
  type SessionSearchScanRoots
} from '../discovery/session-search-scan-roots'
import { SessionSearchDirectoryListings } from '../discovery/session-search-directory-listings'
import { SessionSearchStore } from '../storage/session-search-store'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchPass } from './session-search-pass'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'

const io = vi.hoisted(() => ({ failed: '', paths: [] as string[] }))
vi.mock(
  '../../native-chat/transcript-filesystem/wsl-transcript-fs-access',
  async (importOriginal) => {
    const actual = await importOriginal<typeof TranscriptFs>()
    return {
      ...actual,
      openTranscriptReadStream: (...args: Parameters<typeof actual.openTranscriptReadStream>) => {
        io.paths.push(args[0])
        if (args[0] === io.failed) {
          return new Readable({
            read() {
              this.destroy(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
            }
          })
        }
        return actual.openTranscriptReadStream(...args)
      }
    }
  }
)

let index: SessionSearchIndexFile
let roots: SessionSearchScanRoots
let store: SessionSearchStore
let unregister: () => void
let real: string
let managed: string
beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-codex-aliases')
  const root = dirname(index.path)
  roots = isolatedScanRoots(root)
  const home = join(root, 'real')
  const managedHome = join(root, 'codex-accounts', 'account', 'home')
  const name = 'rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
  real = join(home, 'sessions', name)
  managed = join(managedHome, 'sessions', name)
  roots = {
    ...roots,
    codexSessionsDir: dirname(real),
    defaultCodexHomeDir: home,
    additionalCodexSessionsDirs: [dirname(managed)]
  }
  await mkdir(dirname(real), { recursive: true })
  await mkdir(dirname(managed), { recursive: true })
  await writeFile(
    real,
    `${[
      {
        type: 'session_meta',
        payload: { id: '019f0000-1111-7222-8333-444444444444', cwd: '/repo/app' }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'readablealiasneedle' }]
        }
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`
  )
  await copyFile(real, managed)
  io.failed = real
  io.paths = []
  store = new SessionSearchStore(index.path, (error) => {
    throw error
  })
  unregister = registerSessionSearchIndexConsumer(store)
})
afterEach(async () => {
  unregister()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  store.close()
  await index.close()
  io.failed = ''
})
const sweep = () =>
  runSessionSearchPass({
    store,
    roots,
    full: true,
    recentPerAgent: 100,
    listings: new SessionSearchDirectoryListings(),
    overdue: () => true
  })
function matches() {
  return index.db
    .prepare("SELECT user_text FROM messages_fts WHERE messages_fts MATCH 'readablealiasneedle'")
    .all()
}

it('indexes a readable alias despite a failed preferred open and an overdue pass, then reuses it after restart', async () => {
  await sweep()
  expect(matches()).toEqual([{ user_text: 'readablealiasneedle' }])
  const discovered = await discoverSessionSearchCandidates(roots, {
    limitPerAgent: Infinity
  })
  const candidate = discovered.candidates
    .flatMap(physicalSessionCandidates)
    .find((item) => item.file.path === managed)!
  expect(store.coversTranscript(candidate)).toBe(true)
  // Hold out the failed real path without suppressing the committed managed copy.
  for (let i = 0; i < 3; i++) {
    store.setFileState(real, 'failed', discovered.candidates[0].file.mtimeMs)
  }
  io.paths = []
  await sweep()
  expect(io.paths).toEqual([])
  expect(matches()).toEqual([{ user_text: 'readablealiasneedle' }])
  unregister()
  store.close()
  resetSessionParseCacheForTests()
  store = new SessionSearchStore(index.path, (error) => {
    throw error
  })
  unregister = registerSessionSearchIndexConsumer(store)
  await sweep()
  expect(io.paths).toEqual([])
  expect(matches()).toEqual([{ user_text: 'readablealiasneedle' }])
})

it('does not try another source when a consumer drain fails', async () => {
  io.failed = ''
  const stop = registerTranscriptConsumer({
    beginRead: () => ({
      message() {},
      finish() {},
      drain: async () => {
        throw new Error('store declined')
      }
    })
  })
  try {
    await sweep()
    expect(io.paths).toEqual([real])
  } finally {
    stop()
  }
})

it('does not try another source when flushing the writer fails', async () => {
  io.failed = ''
  const flush = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('flush failed'))
    .mockResolvedValue(undefined)
  Object.assign(store, { flush })
  await sweep()
  expect(io.paths).toEqual([real])
})

it('keeps a successfully excluded canonical rollout excluded on unchanged sweeps', async () => {
  const body = [
    {
      type: 'session_meta',
      payload: {
        id: '019f0000-1111-7222-8333-444444444444',
        source: { internal: 'guardian_review' },
        cwd: '/repo/app'
      }
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'readablealiasneedle' }]
      }
    }
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
  await writeFile(real, `${body}\n`)
  await copyFile(real, managed)
  io.failed = ''
  await sweep()
  expect(matches()).toEqual([])
  io.paths = []
  await sweep()
  expect(io.paths).toEqual([])
  expect(matches()).toEqual([])
})
