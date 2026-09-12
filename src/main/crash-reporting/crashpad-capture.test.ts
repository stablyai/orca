import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const parseMinidumpCrashSignatureMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-in-tests' },
  crashReporter: { start: vi.fn() }
}))
vi.mock('./minidump-crash-signature', () => ({
  parseMinidumpCrashSignature: parseMinidumpCrashSignatureMock
}))

import {
  _pruneCrashpadDumpsForTest,
  _setCrashpadCaptureStateForTest,
  captureMinidumpSignature,
  waitForCrashMinidump
} from './crashpad-capture'

let dumpDir: string

/** Minimal but valid minidump header with a zero-stream directory. */
function emptyDump(): Buffer {
  const buf = Buffer.alloc(32)
  buf.writeUInt32LE(0x504d444d, 0)
  buf.writeUInt32LE(0xa793, 4)
  buf.writeUInt32LE(0, 8)
  buf.writeUInt32LE(32, 12)
  return buf
}

async function writeDump(relativePath: string, mtimeMs: number, contents = emptyDump()) {
  const filePath = path.join(dumpDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  const seconds = mtimeMs / 1000
  await utimes(filePath, seconds, seconds)
  return filePath
}

const CRASHED_AT = 1_700_000_000_000

beforeEach(async () => {
  parseMinidumpCrashSignatureMock.mockReset()
  parseMinidumpCrashSignatureMock.mockReturnValue({ annotations: {} })
  dumpDir = await mkdtemp(path.join(os.tmpdir(), 'orca-crashpad-'))
  _setCrashpadCaptureStateForTest({ dumpDirectory: dumpDir, started: true })
})

afterEach(async () => {
  _setCrashpadCaptureStateForTest(null)
  await rm(dumpDir, { recursive: true, force: true })
})

describe('waitForCrashMinidump', () => {
  it('finds a dump in the nested reports directory Crashpad writes to', async () => {
    const expected = await writeDump(path.join('reports', 'abc.dmp'), CRASHED_AT + 100)

    const dump = await waitForCrashMinidump(CRASHED_AT, { now: () => CRASHED_AT })

    expect(dump?.filePath).toBe(expected)
  })

  it('picks the newest dump when several exist', async () => {
    await writeDump(path.join('reports', 'old.dmp'), CRASHED_AT - 1_000)
    const newest = await writeDump(path.join('reports', 'new.dmp'), CRASHED_AT + 500)

    const dump = await waitForCrashMinidump(CRASHED_AT, { now: () => CRASHED_AT })

    expect(dump?.filePath).toBe(newest)
  })

  it('ignores dumps that predate the crash by more than the recency window', async () => {
    await writeDump(path.join('reports', 'stale.dmp'), CRASHED_AT - 120_000)

    const dump = await waitForCrashMinidump(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(dump).toBeNull()
  })

  it('accepts a dump written just before the crash was observed', async () => {
    // Crashpad writes from the handler process, so the dump can land first.
    const expected = await writeDump(path.join('reports', 'race.dmp'), CRASHED_AT - 200)

    const dump = await waitForCrashMinidump(CRASHED_AT, { now: () => CRASHED_AT })

    expect(dump?.filePath).toBe(expected)
  })

  it('polls until the handler finishes writing, then returns the dump', async () => {
    let clock = CRASHED_AT
    let written = false
    const sleep = async (ms: number) => {
      clock += ms
      if (!written) {
        await writeDump(path.join('reports', 'late.dmp'), CRASHED_AT + 300)
        written = true
      }
    }

    const dump = await waitForCrashMinidump(CRASHED_AT, {
      timeoutMs: 8_000,
      now: () => clock,
      sleep
    })

    expect(dump?.filePath).toBe(path.join(dumpDir, 'reports', 'late.dmp'))
  })

  it('gives up at the deadline instead of polling forever', async () => {
    let clock = CRASHED_AT
    const sleep = async (ms: number) => {
      clock += ms
    }

    const dump = await waitForCrashMinidump(CRASHED_AT, {
      timeoutMs: 1_000,
      now: () => clock,
      sleep
    })

    expect(dump).toBeNull()
    expect(clock).toBeLessThanOrEqual(CRASHED_AT + 1_250)
  })

  it('ignores non-dump files in the directory', async () => {
    await writeDump(path.join('reports', 'settings.dat'), CRASHED_AT + 100)

    const dump = await waitForCrashMinidump(CRASHED_AT, { timeoutMs: 0, now: () => CRASHED_AT })

    expect(dump).toBeNull()
  })

  it('returns null when capture never started', async () => {
    _setCrashpadCaptureStateForTest(null)

    expect(await waitForCrashMinidump(CRASHED_AT)).toBeNull()
  })

  it('returns null when the dump directory does not exist', async () => {
    _setCrashpadCaptureStateForTest({
      dumpDirectory: path.join(dumpDir, 'missing'),
      started: true
    })

    const dump = await waitForCrashMinidump(CRASHED_AT, { timeoutMs: 0, now: () => CRASHED_AT })

    expect(dump).toBeNull()
  })
})

describe('captureMinidumpSignature', () => {
  it('returns the parsed signature for the paired dump', async () => {
    await writeDump(path.join('reports', 'crash.dmp'), CRASHED_AT + 100)

    const captured = await captureMinidumpSignature(CRASHED_AT, { now: () => CRASHED_AT })

    expect(captured?.signature.annotations).toEqual({})
    expect(captured?.sizeBytes).toBe(32)
  })

  it('returns null when the file on disk is not a minidump', async () => {
    await writeDump(path.join('reports', 'garbage.dmp'), CRASHED_AT + 100, Buffer.from('nope'))
    parseMinidumpCrashSignatureMock.mockReturnValueOnce(null)

    const captured = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(captured).toBeNull()
  })

  it('claims a dump once so another report cannot reuse it', async () => {
    const expected = await writeDump(path.join('reports', 'crash.dmp'), CRASHED_AT + 100)

    const first = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })
    const second = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(first?.filePath).toBe(expected)
    expect(second).toBeNull()
  })

  it('skips a newer dump from the wrong process type', async () => {
    const rendererDump = await writeDump(
      path.join('reports', 'renderer.dmp'),
      CRASHED_AT + 100,
      Buffer.from('renderer')
    )
    await writeDump(path.join('reports', 'gpu.dmp'), CRASHED_AT + 200, Buffer.from('gpu-process'))
    parseMinidumpCrashSignatureMock.mockImplementation((dump: Buffer) => ({
      processType: dump.toString('utf8'),
      annotations: {}
    }))

    const captured = await captureMinidumpSignature(CRASHED_AT, {
      expectedProcessType: 'renderer',
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(captured?.filePath).toBe(rendererDump)
    expect(captured?.signature.processType).toBe('renderer')
  })

  it('leaves a mismatched dump available for its own process report', async () => {
    const gpuDump = await writeDump(
      path.join('reports', 'gpu.dmp'),
      CRASHED_AT + 100,
      Buffer.from('gpu-process')
    )
    parseMinidumpCrashSignatureMock.mockReturnValue({
      processType: 'gpu-process',
      annotations: {}
    })

    const renderer = await captureMinidumpSignature(CRASHED_AT, {
      expectedProcessType: 'renderer',
      timeoutMs: 0,
      now: () => CRASHED_AT
    })
    const gpu = await captureMinidumpSignature(CRASHED_AT, {
      expectedProcessType: 'gpu-process',
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(renderer).toBeNull()
    expect(gpu?.filePath).toBe(gpuDump)
  })

  it('returns null rather than throwing when no dump was produced', async () => {
    const captured = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })

    expect(captured).toBeNull()
  })
})

describe('Crashpad dump pruning', () => {
  it('keeps the newest dumps within the byte budget', async () => {
    await writeDump(path.join('reports', 'old.dmp'), CRASHED_AT, Buffer.alloc(8))
    await writeDump(path.join('reports', 'middle.dmp'), CRASHED_AT + 100, Buffer.alloc(8))
    await writeDump(path.join('reports', 'new.dmp'), CRASHED_AT + 200, Buffer.alloc(8))

    await _pruneCrashpadDumpsForTest(16)

    expect((await readdir(path.join(dumpDir, 'reports'))).sort()).toEqual(['middle.dmp', 'new.dmp'])
  })

  it('caps the dump count even when every dump fits the byte budget', async () => {
    await writeDump(path.join('reports', 'old.dmp'), CRASHED_AT, Buffer.alloc(8))
    await writeDump(path.join('reports', 'middle.dmp'), CRASHED_AT + 100, Buffer.alloc(8))
    await writeDump(path.join('reports', 'new.dmp'), CRASHED_AT + 200, Buffer.alloc(8))

    await _pruneCrashpadDumpsForTest(1024, 2)

    expect((await readdir(path.join(dumpDir, 'reports'))).sort()).toEqual(['middle.dmp', 'new.dmp'])
  })

  it('keeps a dump already claimed by a persisted crash report', async () => {
    await writeDump(path.join('reports', 'claimed.dmp'), CRASHED_AT + 200, Buffer.alloc(8))
    const captured = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })
    expect(captured?.filePath).toBe(path.join(dumpDir, 'reports', 'claimed.dmp'))
    // Newer than the claimed dump, so the claim is what protects it, not index 0.
    await writeDump(path.join('reports', 'newest.dmp'), CRASHED_AT + 400, Buffer.alloc(8))

    await _pruneCrashpadDumpsForTest(8)

    expect((await readdir(path.join(dumpDir, 'reports'))).sort()).toEqual([
      'claimed.dmp',
      'newest.dmp'
    ])
  })
})
