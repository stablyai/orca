import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type ReaderState = {
  path: string
  opens: number
  closes: number
  handles: FileHandle[]
  bytesRead: number
  statErrorOn: number
  readError: boolean
  afterStat: (() => Promise<void>) | null
}

const state = vi.hoisted((): ReaderState => ({
  path: '',
  opens: 0,
  closes: 0,
  handles: [],
  bytesRead: 0,
  statErrorOn: 0,
  readError: false,
  afterStat: null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (path: string, flags: string) => {
      const handle = await fs.open(path, flags)
      if (path !== state.path) {
        return handle
      }
      state.opens++
      state.handles.push(handle)
      let statsRead = 0
      return {
        stat: async () => {
          statsRead++
          if (statsRead === state.statErrorOn) {
            throw new Error('Injected stat failure')
          }
          const snapshot = await handle.stat()
          const afterStat = state.afterStat
          state.afterStat = null
          await afterStat?.()
          return snapshot
        },
        createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
          const stream = handle.createReadStream(options)
          stream.once('end', () => {
            state.bytesRead += stream.bytesRead
          })
          if (state.readError) {
            queueMicrotask(() => stream.destroy(new Error('Injected read failure')))
          }
          return stream
        },
        close: async () => {
          await handle.close()
          state.closes++
        }
      }
    }
  }
})

import { appendFile, mkdtemp, rename, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import {
  ClaudeTranscriptPreviousCursorMissingError,
  ClaudeTranscriptTailIncompleteError,
  replayClaudeTranscriptBranchAncestry,
  replayClaudeTranscriptBranchAncestryFromJsonl
} from './claude-transcript-branch-proof'

const row = (uuid: string, parentUuid: string | null, extra = {}) =>
  `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'provider', ...extra })}\n`
const marker = (leafUuid: string, sessionId = 'provider') =>
  `${JSON.stringify({ type: 'last-prompt', leafUuid, sessionId })}\n`
/** Carries no uuid, so it can be neither a tip nor a marker. */
const SUMMARY = `${JSON.stringify({ type: 'summary', summary: 'title' })}\n`
const ROOT = row('root', null)
const CHILD = row('child', 'root')
const SOURCE = ROOT + marker('root')
let directory = ''
let replayed: string[] = []
// The live caller always anchors the replay at the cursor it already holds.
const replay = (anchorUuid = 'root') =>
  replayClaudeTranscriptBranchAncestry({
    transcriptPath: state.path,
    providerSessionId: 'provider',
    previousLeafUuid: anchorUuid,
    ancestryAnchorUuid: anchorUuid,
    onAncestorRecord: (_record, uuid) => replayed.push(uuid)
  })
const read = async (anchorUuid?: string) => (await replay(anchorUuid)).proof

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-branch-streaming-'))
  replayed = []
  Object.assign(state, {
    path: join(directory, 'transcript.jsonl'),
    opens: 0,
    closes: 0,
    handles: [],
    bytesRead: 0,
    statErrorOn: 0,
    readError: false,
    afterStat: null
  })
  await writeFile(state.path, SOURCE)
})

afterEach(async () => {
  try {
    expect(state.closes).toBe(state.opens)
    for (const handle of state.handles) {
      // Another test can reuse a closed descriptor number in this process.
      expect(handle.fd).toBe(-1)
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('decodes UTF-8 across chunks and replays ancestry beyond large message bodies', async () => {
  const prefix = JSON.stringify({ type: 'comment', content: '' }).indexOf('"content":"') + 11
  const comment = `${JSON.stringify({ type: 'comment', content: `${'x'.repeat(65535 - prefix)}🙂é漢字` })}\n`
  const contents =
    comment +
    row('root', null, { message: 'x'.repeat(2 * 1024 * 1024) }) +
    CHILD +
    marker('child').trimEnd()
  await writeFile(state.path, contents)
  const fromString: string[] = []
  expect(await replay()).toEqual(
    replayClaudeTranscriptBranchAncestryFromJsonl({
      contents,
      providerSessionId: 'provider',
      previousLeafUuid: 'root',
      ancestryAnchorUuid: 'root',
      onAncestorRecord: (_record, uuid) => fromString.push(uuid)
    })
  )
  expect(replayed).toEqual(fromString)
  expect(replayed).toEqual(['child'])
})

it.each([
  ['malformed middle', `{"broken":\n${SOURCE}`, false],
  ['unterminated malformed tail', `${SOURCE}{"broken":`, true],
  ['terminated malformed tail', `${SOURCE}{"broken":\n`, false]
] as const)(
  'preserves error classification for %s and closes the file',
  async (_name, contents, incomplete) => {
    await writeFile(state.path, contents)
    const result = read()
    await (incomplete
      ? expect(result).rejects.toBeInstanceOf(ClaudeTranscriptTailIncompleteError)
      : expect(result).rejects.not.toBeInstanceOf(ClaudeTranscriptTailIncompleteError))
  }
)

it('proves only the original finite prefix while the same file grows', async () => {
  state.afterStat = () => appendFile(state.path, CHILD + marker('child') + ' '.repeat(1024 * 1024))
  expect(await read()).toEqual({ leafUuid: 'root', relation: 'same' })
  expect(state.bytesRead).toBe(Buffer.byteLength(SOURCE))
})

it('replays the ancestry off the same pinned prefix the proof read', async () => {
  const contents = ROOT + CHILD
  await writeFile(state.path, contents)
  state.afterStat = () => appendFile(state.path, row('grandchild', 'child'))
  expect(await replay()).toEqual({
    proof: { leafUuid: 'child', relation: 'descendant' },
    chain: ['child']
  })
  expect(replayed).toEqual(['child'])
  expect(state.bytesRead).toBe(Buffer.byteLength(contents) * 2)
})

it.each([
  ['empty', '', SOURCE, 'root'],
  ['missing previous cursor', SOURCE, CHILD + marker('child'), 'child']
] as const)(
  'finishes a growing %s proof on the same open handle',
  async (_name, contents, growth, anchor) => {
    await writeFile(state.path, contents)
    state.afterStat = () => appendFile(state.path, growth)
    expect((await read(anchor)).leafUuid).toBe(anchor)
    expect(state.opens).toBe(1)
  }
)

it.each(['', SUMMARY])('keeps a static missing tip fatal', async (contents) => {
  await writeFile(state.path, contents)
  await expect(read()).rejects.toThrow('missing last-prompt marker')
})

it('preserves the typed static missing-cursor error for existing root reproof', async () => {
  await expect(read('absent')).rejects.toBeInstanceOf(ClaudeTranscriptPreviousCursorMissingError)
})

it.each([
  ['conflict', ROOT + row('root', 'foreign') + marker('root'), 'root', 'conflicting ancestry'],
  ['wrong session', ROOT + marker('root', 'foreign'), 'root', 'invalid last-prompt'],
  ['append order', CHILD + ROOT, 'root', 'parent row follows'],
  ['missing ancestor', CHILD, 'child', 'missing ancestor']
] as const)(
  'does not turn %s into a retry when the file grows',
  async (_name, contents, anchor, message) => {
    await writeFile(state.path, contents)
    state.afterStat = () => appendFile(state.path, CHILD)
    await expect(read(anchor)).rejects.toThrow(message)
  }
)

it('does not infer growth from a failed second stat', async () => {
  await writeFile(state.path, '')
  state.afterStat = () => appendFile(state.path, SOURCE)
  state.statErrorOn = 2
  await expect(read()).rejects.toThrow('missing last-prompt marker')
})

it('keeps reading the original handle after pathname replacement', async () => {
  state.afterStat = async () => {
    await rename(state.path, `${state.path}.original`)
    await writeFile(state.path, ROOT + CHILD + marker('child'))
  }
  expect((await read()).leafUuid).toBe('root')
})

it('does not use a replacement file to establish growth', async () => {
  await writeFile(state.path, '')
  state.afterStat = async () => {
    await rename(state.path, `${state.path}.original`)
    await writeFile(state.path, ROOT + CHILD + marker('child'))
  }
  await expect(read()).rejects.toThrow('missing last-prompt marker')
})

it('can finish an opened file after unlink', async () => {
  state.afterStat = () => unlink(state.path)
  expect((await read()).leafUuid).toBe('root')
})

it('does not infer growth from truncation', async () => {
  state.afterStat = () => truncate(state.path, 0)
  await expect(read()).rejects.toThrow('missing last-prompt marker')
})

it.each(['stat', 'read'] as const)('awaits closure after a %s failure', async (failure) => {
  state.statErrorOn = failure === 'stat' ? 1 : 0
  state.readError = failure === 'read'
  await expect(read()).rejects.toThrow(`Injected ${failure} failure`)
})

it('completes a record appended after the first observed extent without caller retry', async () => {
  const contents = ROOT + marker('root').slice(0, -5)
  await writeFile(state.path, contents)
  state.afterStat = () => appendFile(state.path, marker('root').slice(-5))
  expect((await read()).leafUuid).toBe('root')
  expect(state.opens).toBe(1)
})

it('validates the entire refreshed prefix instead of accepting a malformed repair', async () => {
  const conflicting = row('root', 'foreign')
  await writeFile(state.path, ROOT + conflicting.slice(0, -5))
  state.afterStat = () => appendFile(state.path, conflicting.slice(-5))
  await expect(read()).rejects.toThrow('conflicting ancestry')
  expect(state.opens).toBe(1)
})

it('keeps an unfinished growing repair retryable after one internal refresh', async () => {
  const torn = ROOT.slice(0, -5)
  await writeFile(state.path, torn)
  state.afterStat = () => appendFile(state.path, ' ')
  await expect(read()).rejects.toBeInstanceOf(ClaudeTranscriptTailIncompleteError)
  expect(state.opens).toBe(1)
  expect(state.bytesRead).toBe(Buffer.byteLength(torn) * 2 + 1)
})
