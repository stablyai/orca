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
})

describe('captureMinidumpSignature', () => {
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
})

describe('Crashpad dump pruning', () => {
  it('keeps the newest dumps within the byte budget', async () => {
    await writeDump(path.join('reports', 'old.dmp'), CRASHED_AT, Buffer.alloc(8))
    await writeDump(path.join('reports', 'middle.dmp'), CRASHED_AT + 100, Buffer.alloc(8))
    await writeDump(path.join('reports', 'new.dmp'), CRASHED_AT + 200, Buffer.alloc(8))

    await _pruneCrashpadDumpsForTest(16)

    expect((await readdir(path.join(dumpDir, 'reports'))).sort()).toEqual(['middle.dmp', 'new.dmp'])
  })

  it('keeps a dump already claimed by a persisted crash report', async () => {
    await writeDump(path.join('reports', 'claimed.dmp'), CRASHED_AT + 200, Buffer.alloc(8))
    const captured = await captureMinidumpSignature(CRASHED_AT, {
      timeoutMs: 0,
      now: () => CRASHED_AT
    })
    expect(captured?.filePath).toBe(path.join(dumpDir, 'reports', 'claimed.dmp'))
    // Make another dump newest so only the persisted claim protects this one.
    await writeDump(path.join('reports', 'newest.dmp'), CRASHED_AT + 400, Buffer.alloc(8))

    await _pruneCrashpadDumpsForTest(8)

    expect((await readdir(path.join(dumpDir, 'reports'))).sort()).toEqual([
      'claimed.dmp',
      'newest.dmp'
    ])
  })
})
