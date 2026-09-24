/**
 * Transcript readers open a path whose directory the agent controls, and they
 * open it repeatedly: a tail read, a branch proof, a gated open, a stream. Two
 * file kinds abuse that.
 *
 * A symlink planted between the resolver's check and the reader's open makes
 * the reader follow it — the classic TOCTOU swap — and the reader then vouches
 * for bytes from outside the transcript tree. Measured on the base revision:
 * `readClaudeTranscriptLeafUuid` returned the *linked* file's uuid. A FIFO is
 * worse: a blocking open of a writer-less FIFO never returns, and on the base
 * revision the same reader parked the process until the suite's timeout killed
 * it.
 *
 * The rest of the main process already opens attacker-adjacent paths with
 * `O_RDONLY | O_NOFOLLOW` (`ssh/sftp-upload.ts`, `ipc/runtime-upload-file-stream.ts`,
 * `crash-reporting/crashpad-capture.ts`). The transcript readers were the gap.
 *
 * Hang detection here is the per-test timeout, not a wall-clock race inside the
 * test: a reader that blocks never resolves, so the assertion below can only be
 * reached by a reader that settles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readClaudeTranscriptLeafUuid } from '../claude/claude-tui-exit'
import { proveClaudeTranscriptBranch } from '../claude/claude-transcript-branch-proof'
import {
  closeTranscriptHandle,
  openTranscriptReadStream,
  wslGatedOpen,
  wslGatedRead
} from './wsl-transcript-fs-access'

const execFileAsync = promisify(execFile)

/** O_NOFOLLOW is POSIX-only; on Windows the constant is absent and the flag degrades to 0. */
const supportsNoFollow = typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0
/** mkfifo is POSIX-only, and Windows has no path that blocks an open this way. */
const supportsFifo = process.platform !== 'win32'

/** A blocking reader never reaches its assertion; fail it well before the default timeout. */
const SETTLE_TIMEOUT_MS = 5_000

const LEAF_UUID = '11111111-1111-4111-8111-111111111111'
const LINKED_UUID = '99999999-9999-4999-8999-999999999999'
const TRANSCRIPT_LINE = JSON.stringify({
  type: 'assistant',
  uuid: LEAF_UUID,
  parentUuid: null,
  message: { role: 'assistant', content: 'hi' }
})

let dir = ''
let transcriptPath = ''
let symlinkPath = ''
let fifoPath = ''

function branchProofInput(transcriptPath: string) {
  return { transcriptPath, providerSessionId: 'session-1', previousLeafUuid: null }
}

async function readStreamToEnd(path: string): Promise<void> {
  const stream = openTranscriptReadStream(path, { encoding: 'utf8' }, 'exact')
  await new Promise<void>((resolve, reject) => {
    stream.on('data', () => {})
    stream.on('end', resolve)
    stream.on('close', resolve)
    stream.on('error', reject)
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'transcript-read-hardening-'))
  transcriptPath = join(dir, 'session.jsonl')
  symlinkPath = join(dir, 'swapped.jsonl')
  fifoPath = join(dir, 'fifo.jsonl')
  await writeFile(transcriptPath, `${TRANSCRIPT_LINE}\n`, 'utf8')
  const linkedPath = join(dir, 'outside-the-tree.jsonl')
  await writeFile(
    linkedPath,
    `${JSON.stringify({ type: 'assistant', uuid: LINKED_UUID, parentUuid: null })}\n`,
    'utf8'
  )
  await symlink(linkedPath, symlinkPath)
  if (supportsFifo) {
    await execFileAsync('mkfifo', [fifoPath])
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!supportsNoFollow)('a transcript path swapped for a symlink is refused', () => {
  it('the tail reader does not harvest the linked file', async () => {
    await expect(readClaudeTranscriptLeafUuid(symlinkPath)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('the branch proof does not read the linked file', async () => {
    await expect(proveClaudeTranscriptBranch(branchProofInput(symlinkPath))).rejects.toMatchObject({
      code: 'ELOOP'
    })
  })

  it('the gated open does not open the linked file', async () => {
    await expect(wslGatedOpen(symlinkPath, 'exact')).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('the read stream does not stream the linked file', async () => {
    await expect(readStreamToEnd(symlinkPath)).rejects.toMatchObject({ code: 'ELOOP' })
  })
})

describe.skipIf(!supportsFifo)(
  'a transcript path swapped for a FIFO does not park the reader',
  () => {
    it(
      'the tail reader finds no leaf and returns',
      async () => {
        await expect(readClaudeTranscriptLeafUuid(fifoPath)).resolves.toBeNull()
      },
      SETTLE_TIMEOUT_MS
    )

    it(
      'the branch proof fails instead of blocking',
      async () => {
        await expect(proveClaudeTranscriptBranch(branchProofInput(fifoPath))).rejects.toThrow()
      },
      SETTLE_TIMEOUT_MS
    )

    it(
      'the gated open returns a handle instead of blocking',
      async () => {
        const handle = await wslGatedOpen(fifoPath, 'exact')
        await expect(closeTranscriptHandle(handle, fifoPath)).resolves.toBeUndefined()
      },
      SETTLE_TIMEOUT_MS
    )

    it(
      'the read stream ends instead of blocking',
      async () => {
        await expect(readStreamToEnd(fifoPath)).resolves.toBeUndefined()
      },
      SETTLE_TIMEOUT_MS
    )
  }
)

describe('an ordinary transcript still reads', () => {
  it('the tail reader returns its leaf uuid', async () => {
    await expect(readClaudeTranscriptLeafUuid(transcriptPath)).resolves.toBe(LEAF_UUID)
  })

  it('the gated open reads the bytes back', async () => {
    const handle = await wslGatedOpen(transcriptPath, 'exact')
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_LINE.length)
      await wslGatedRead(handle, transcriptPath, buffer, 0, buffer.length, 0, 'exact')
      expect(buffer.toString('utf8')).toBe(TRANSCRIPT_LINE)
    } finally {
      await closeTranscriptHandle(handle, transcriptPath)
    }
  })

  it('the read stream reaches the end', async () => {
    await expect(readStreamToEnd(transcriptPath)).resolves.toBeUndefined()
  })
})
