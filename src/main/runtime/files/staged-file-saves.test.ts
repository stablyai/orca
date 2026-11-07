import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/staged-file-save'
import { StagedFileSaves } from './staged-file-saves'

// An append can be held open to put other ops beside it.
const appendGate = vi.hoisted((): { hold: Promise<void> | null } => ({ hold: null }))
const createGate = vi.hoisted(
  (): {
    hold: Promise<void> | null
    entered: boolean
    failAfterCreate: boolean
    looseDirectory: boolean
  } => ({
    hold: null,
    entered: false,
    failAfterCreate: false,
    looseDirectory: false
  })
)
const removeGate = vi.hoisted((): { hold: Promise<void> | null; entered: boolean } => ({
  hold: null,
  entered: false
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      await appendGate.hold
      return actual.appendFile(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      createGate.entered = true
      await createGate.hold
      await actual.writeFile(...args)
      if (createGate.failAfterCreate) {
        throw new Error('staged_save_create_failed')
      }
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stats = await actual.stat(...args)
      if (createGate.looseDirectory && String(args[0]) === join(staging, String(PID))) {
        return Object.assign(stats, { mode: (Number(stats.mode) & ~0o777) | 0o755 })
      }
      return stats
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const options = args[1]
      if (options && typeof options === 'object' && 'recursive' in options && options.recursive) {
        return actual.rm(...args)
      }
      removeGate.entered = true
      await removeGate.hold
      return actual.rm(...args)
    }
  }
})
void (384 * 1024)

let root: string
let staging: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-staged-save-'))
  staging = join(root, 'profile', 'staged-saves')
  appendGate.hold = null
  createGate.hold = null
  createGate.entered = false
  createGate.failAfterCreate = false
  createGate.looseDirectory = false
  removeGate.hold = null
  removeGate.entered = false
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const saves = (limits: Partial<typeof STAGED_FILE_SAVE_LIMITS> = {}) =>
  new StagedFileSaves({
    stagingDir: () => staging,
    limits: { ...STAGED_FILE_SAVE_LIMITS, ...limits },
    pid: PID,
    ownerLiveness: (pid) =>
      pid === 111
        ? { status: 'exited' }
        : pid === 333
          ? { status: 'unverifiable', reason: 'test' }
          : { status: 'live' }
  })

const at = (path: string) => ({ requestedPath: path, realPath: path })
const same = async (path: string) => path

const PID = 4242
const ownDir = () => join(staging, String(PID))
const temps = () => (existsSync(ownDir()) ? readdirSync(ownDir()) : [])

// E7: a 5 MB lockfile opened from a remote host could be edited but not saved (720 KB cap).
describe('a staged save', () => {
  void '"node_modules/pkg": { "version": "1.0.0" },\n'.repeat(120_000)

  it('restricts the staging directory and temp file to their owner', async () => {
    mkdirSync(ownDir(), { recursive: true, mode: 0o777 })
    chmodSync(ownDir(), 0o777)
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(join(root, 'a.txt')), 1)
    if (process.platform === 'win32') {
      await staged.abortConnection('conn-1')
      return
    }

    expect(statSync(ownDir()).mode & 0o777).toBe(0o700)
    expect(statSync(join(ownDir(), `${saveId}.tmp`)).mode & 0o777).toBe(0o600)
    await staged.abortConnection('conn-1')
  })

  // Review of #35073: an abort mid-append left a temp; a quick commit read a short one.
  it('removes the temp only after an append in flight settles, and commits only whole content', async () => {
    const staged = saves()
    let release = () => {}
    appendGate.hold = new Promise((resolve) => {
      release = resolve
    })
    const first = await staged.begin('conn-1', at(join(root, 'a.txt')), 3)
    const appending = staged.append('conn-1', first.saveId, 0, Buffer.from('abc'))
    const aborted = staged.abort('conn-1', first.saveId)
    release()
    await appending
    await aborted
    expect(temps()).toEqual([])

    appendGate.hold = new Promise((resolve) => {
      release = resolve
    })
    const target = join(root, 'b.txt')
    const second = await staged.begin('conn-1', at(target), 3)
    const appended = staged.append('conn-1', second.saveId, 0, Buffer.from('xyz'))
    const committed = staged.commit('conn-1', second.saveId, undefined, same)
    release()
    await appended
    await expect(committed).resolves.toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('xyz')
  })

  it('keeps a save reserved until abort removes a temp still being created', async () => {
    let release = () => {}
    createGate.hold = new Promise((resolve) => {
      release = resolve
    })
    const staged = saves({ maxSavesPerConnection: 1, maxSavesPerHost: 1 })
    const starting = staged.begin('conn-1', at(join(root, 'a.txt')), 1)
    await vi.waitFor(() => expect(createGate.entered).toBe(true))

    const aborting = staged.abortConnection('conn-1')
    await expect(staged.begin('conn-1', at(join(root, 'b.txt')), 1)).rejects.toThrow(
      'staged_save_limit'
    )

    release()
    await expect(starting).rejects.toThrow('staged_save_unknown')
    await aborting
    expect(temps()).toEqual([])
    await expect(staged.begin('conn-1', at(join(root, 'b.txt')), 1)).resolves.toEqual(
      expect.objectContaining({ saveId: expect.any(String) })
    )
    await staged.abortConnection('conn-1')
  })

  it('keeps a failed setup reserved until its temp is removed', async () => {
    let release = () => {}
    removeGate.hold = new Promise((resolve) => {
      release = resolve
    })
    createGate.failAfterCreate = true
    const staged = saves({ maxSavesPerConnection: 1, maxSavesPerHost: 1 })
    const starting = staged.begin('conn-1', at(join(root, 'a.txt')), 1)
    await vi.waitFor(() => expect(removeGate.entered).toBe(true))

    await expect(staged.begin('conn-1', at(join(root, 'b.txt')), 1)).rejects.toThrow(
      'staged_save_limit'
    )

    release()
    await expect(starting).rejects.toThrow('staged_save_create_failed')
    expect(temps()).toEqual([])
    createGate.failAfterCreate = false
    await expect(staged.begin('conn-1', at(join(root, 'b.txt')), 1)).resolves.toEqual(
      expect.objectContaining({ saveId: expect.any(String) })
    )
    await staged.abortConnection('conn-1')
  })

  it('keeps a committing save charged when abort runs before commit settles', async () => {
    const staged = saves({ maxSavesPerConnection: 1, maxSavesPerHost: 1 })
    const target = join(root, 'commit.txt')
    const first = await staged.begin('conn-1', at(target), 3)
    await staged.append('conn-1', first.saveId, 0, Buffer.from('abc'))
    let release: (() => void) | undefined
    const committing = staged.commit(
      'conn-1',
      first.saveId,
      undefined,
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(target)
        })
    )
    await vi.waitFor(() => expect(release).toBeDefined())

    await staged.abort('conn-1', first.saveId)
    await expect(staged.begin('conn-1', at(join(root, 'second.txt')), 1)).rejects.toThrow(
      'staged_save_limit'
    )

    release!()
    await expect(committing).resolves.toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('abc')
    expect(temps()).toEqual([])
    await expect(staged.begin('conn-1', at(join(root, 'second.txt')), 1)).resolves.toEqual(
      expect.objectContaining({ saveId: expect.any(String) })
    )
    await staged.abortConnection('conn-1')
  })

  it("clears at host start its own and exited owners' folders, and nothing a live process holds", async () => {
    for (const owner of [String(PID), '111', '222', '333', 'not-a-pid']) {
      mkdirSync(join(staging, owner), { recursive: true })
      writeFileSync(join(staging, owner, 'save.tmp'), 'partial')
    }
    writeFileSync(join(root, 'notes.tmp'), 'keep')

    await saves().sweepOrphans()
    // Its own folder from a previous run and an exited owner's go; a live or uncheckable owner's stay.
    expect(readdirSync(staging).toSorted()).toEqual(['222', '333', 'not-a-pid'])
    expect(existsSync(join(root, 'notes.tmp'))).toBe(true)
  })

  it('refuses a commit whose temp was cut short outside this process', async () => {
    const target = join(root, 'a.txt')
    writeFileSync(target, 'old')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(target), 6)
    await staged.append('conn-1', saveId, 0, Buffer.from('abcdef'))
    truncateSync(join(ownDir(), `${saveId}.tmp`), 2)

    await expect(staged.commit('conn-1', saveId, undefined, same)).rejects.toThrow(
      'staged_save_incomplete'
    )
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(temps()).toEqual([])
  })
})
