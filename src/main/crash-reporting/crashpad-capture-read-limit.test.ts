import type * as FsModule from 'node:fs/promises'
import type * as ParserModule from './minidump-crash-signature'
import { constants as fsConstants } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  open,
  rm,
  rename,
  symlink,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const callbacks: {
    afterStat?: (path: string) => Promise<void>
    afterOpenStat?: (path: string) => Promise<void>
  } = {}
  const parsedBytes: number[] = []
  const closedPaths: string[] = []
  return { callbacks, parsedBytes, closedPaths }
})
vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
  crashReporter: { start: vi.fn() }
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsModule>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const readStat = handle.stat.bind(handle)
      const close = handle.close.bind(handle)
      return Object.assign(handle, {
        stat: async () => {
          const stats = await readStat()
          await state.callbacks.afterOpenStat?.(String(args[0]))
          return stats
        },
        close: async () => {
          await close()
          state.closedPaths.push(String(args[0]))
        }
      })
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const stats = await fs.stat(...args)
      await state.callbacks.afterStat?.(String(args[0]))
      return stats
    }
  }
})
vi.mock('./minidump-crash-signature', async (original) => {
  const parser = await original<typeof ParserModule>()
  return {
    ...parser,
    parseMinidumpCrashSignature: (
      ...args: Parameters<typeof parser.parseMinidumpCrashSignature>
    ) => {
      state.parsedBytes.push(args[0].byteLength)
      return parser.parseMinidumpCrashSignature(...args)
    }
  }
})
import { _setCrashpadCaptureStateForTest, captureMinidumpSignature } from './crashpad-capture'

const LIMIT = 64 * 1024 * 1024
const CRASHED_AT = 1_700_000_000_000
let directory: string
function rendererDump() {
  const dump = Buffer.alloc(131)
  dump.writeUInt32LE(0x504d444d, 0)
  dump.writeUInt32LE(0xa793, 4)
  dump.writeUInt32LE(1, 8)
  dump.writeUInt32LE(32, 12)
  dump.writeUInt32LE(0x43500001, 32)
  dump.writeUInt32LE(52, 36)
  dump.writeUInt32LE(44, 40)
  dump.writeUInt32LE(1, 44)
  dump.writeUInt32LE(12, 80)
  dump.writeUInt32LE(96, 84)
  dump.writeUInt32LE(1, 96)
  dump.writeUInt32LE(108, 100)
  dump.writeUInt32LE(118, 104)
  dump.writeUInt32LE(5, 108)
  dump.write('ptype', 112)
  dump.writeUInt32LE(8, 118)
  dump.write('renderer', 122)
  return dump
}
async function file(name: string, newer = false, bytes = rendererDump()) {
  const path = join(directory, 'new', name)
  await writeFile(path, bytes)
  await utimes(path, CRASHED_AT / 1000, (CRASHED_AT + (newer ? 100 : 0)) / 1000)
  return path
}
function capture() {
  return captureMinidumpSignature(CRASHED_AT, {
    expectedProcessType: 'renderer',
    timeoutMs: 0,
    now: () => CRASHED_AT
  })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-crashpad-limit-'))
  await mkdir(join(directory, 'new'))
  state.callbacks.afterStat = undefined
  state.callbacks.afterOpenStat = undefined
  state.parsedBytes.length = 0
  state.closedPaths.length = 0
  _setCrashpadCaptureStateForTest({ dumpDirectory: directory, started: true })
})
afterEach(async () => {
  _setCrashpadCaptureStateForTest(null)
  await rm(directory, { recursive: true, force: true })
})

it.each(['growth', 'replacement'] as const)(
  'captures %s past the initial limit without a whole-file allocation',
  async (kind) => {
    const next = await file('next.dmp')
    const unfinished = rendererDump()
    unfinished.writeUInt32LE(0, 0)
    const race = await file('racing.dmp', true, unfinished)
    state.callbacks.afterStat = async (path) => {
      if (path !== race) {
        return
      }
      state.callbacks.afterStat = undefined
      if (kind === 'replacement') {
        await rename(race, join(directory, 'retired.bin'))
        await writeFile(race, unfinished)
      }
      await truncate(race, LIMIT + 1024 * 1024)
      const handle = await open(race, 'r+')
      try {
        await handle.write(rendererDump().subarray(0, 4), 0, 4, 0)
      } finally {
        await handle.close()
      }
    }
    const result = await capture()
    expect(state.parsedBytes).toEqual([LIMIT + 1024 * 1024])
    expect(result?.filePath).toBe(race)
    expect(next).not.toBe(race)
  }
)

it('accepts exactly the existing 64 MiB limit', async () => {
  const path = await file('limit.dmp')
  await truncate(path, LIMIT)
  const result = await capture()
  expect(result?.filePath).toBe(path)
  expect(result?.sizeBytes).toBe(LIMIT)
  expect(state.parsedBytes).toEqual([LIMIT])
})

it('ignores an already oversize candidate without parsing it', async () => {
  const next = await file('next.dmp')
  const path = await file('oversize.dmp', true)
  await truncate(path, LIMIT + 1024 * 1024)
  const result = await capture()
  expect(result?.filePath).toBe(next)
  expect(state.parsedBytes).toEqual([131])
})

it('documents same-path partial-header rejection for this capture window', async () => {
  const path = await file('partial.dmp', false, Buffer.from('MDMP'))
  let clock = CRASHED_AT
  const result = await captureMinidumpSignature(CRASHED_AT, {
    expectedProcessType: 'renderer',
    timeoutMs: 500,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      await writeFile(path, rendererDump())
    }
  })
  expect(result).toBeNull()
  expect(state.parsedBytes).toEqual([4])
  expect((await capture())?.filePath).toBe(path)
})

it('can recover partial-header rejection after completed-path promotion', async () => {
  const path = await file('partial.dmp', false, Buffer.from('MDMP'))
  const promoted = join(directory, 'pending', 'partial.dmp')
  let clock = CRASHED_AT
  const result = await captureMinidumpSignature(CRASHED_AT, {
    expectedProcessType: 'renderer',
    timeoutMs: 500,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      await writeFile(path, rendererDump())
      await mkdir(join(directory, 'pending'))
      await rename(path, promoted)
    }
  })
  expect(result?.filePath).toBe(promoted)
  expect(state.parsedBytes).toEqual([4, 131])
})

it('preserves the opened dump when later growth exceeds the limit', async () => {
  const next = await file('next.dmp')
  const race = await file('racing.dmp', true)
  let grew = false
  state.callbacks.afterOpenStat = async (path) => {
    if (path !== race) {
      return
    }
    state.callbacks.afterOpenStat = undefined
    grew = true
    await truncate(race, LIMIT + 1024 * 1024)
  }
  const result = await capture()
  expect(grew).toBe(true)
  expect(result?.filePath).toBe(race)
  expect(result?.sizeBytes).toBe(131)
  expect(state.parsedBytes).toEqual([131])
  expect(state.closedPaths).toEqual([race])
  expect((await capture())?.filePath).toBe(next)
})

it('records bytes actually parsed when permitted growth follows directory stat', async () => {
  const race = await file('racing.dmp')
  state.callbacks.afterStat = async (path) => {
    if (path !== race) {
      return
    }
    state.callbacks.afterStat = undefined
    await truncate(race, 132)
  }
  expect((await capture())?.sizeBytes).toBe(132)
  expect(state.parsedBytes).toEqual([132])
})

it('captures a size-zero opened dump that gains contents before its first read', async () => {
  const race = await file('racing.dmp', false, Buffer.alloc(0))
  state.callbacks.afterOpenStat = async (path) => {
    if (path === race) {
      state.callbacks.afterOpenStat = undefined
      await writeFile(path, rendererDump())
    }
  }
  const result = await capture()
  expect(result?.filePath).toBe(race)
  expect(result?.signature.processType).toBe('renderer')
  expect(result?.sizeBytes).toBe(131)
})

it('reports the observed shorter extent when the opened dump shrinks while reading', async () => {
  const race = await file('shrinking.dmp', false, Buffer.concat([rendererDump(), Buffer.alloc(10)]))
  state.callbacks.afterOpenStat = async (path) => {
    if (path === race) {
      state.callbacks.afterOpenStat = undefined
      await truncate(path, 131)
    }
  }
  const result = await capture()
  expect(result?.signature.processType).toBe('renderer')
  expect(result?.sizeBytes).toBe(131)
})

it.skipIf(!fsConstants.O_NOFOLLOW)(
  'skips a swapped symlink and captures another valid dump',
  async () => {
    const next = await file('next.dmp')
    const race = await file('swapped.dmp', true)
    state.callbacks.afterStat = async (path) => {
      if (path === race) {
        state.callbacks.afterStat = undefined
        await rm(race)
        await symlink(next, race)
      }
    }
    expect((await capture())?.filePath).toBe(next)
    expect(state.parsedBytes).toEqual([131])
    expect(state.closedPaths).toEqual([next])
  }
)

it.each(['missing', 'directory'] as const)('skips a candidate replaced by %s', async (kind) => {
  const next = await file('next.dmp')
  const race = await file('swapped.dmp', true)
  state.callbacks.afterStat = async (path) => {
    if (path === race) {
      state.callbacks.afterStat = undefined
      await rm(race)
      if (kind === 'directory') {
        await mkdir(race)
      }
    }
  }
  expect((await capture())?.filePath).toBe(next)
  expect(state.parsedBytes).toEqual([131])
  expect(state.closedPaths).toContain(next)
})
