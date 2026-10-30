import {
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
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/staged-file-save'
import { StagedFileSaves } from './staged-file-saves'

// An append can be held open to put other ops beside it.
const appendGate = vi.hoisted((): { hold: Promise<void> | null } => ({ hold: null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      await appendGate.hold
      return actual.appendFile(...args)
    }
  }
})

const CHUNK = 384 * 1024

let root: string
let staging: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-staged-save-'))
  staging = join(root, 'profile', 'staged-saves')
  appendGate.hold = null
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

async function send(staged: StagedFileSaves, owner: string, saveId: string, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    await staged.append(owner, saveId, offset, bytes.subarray(offset, offset + CHUNK))
  }
}

const PID = 4242
const ownDir = () => join(staging, String(PID))
const temps = () => (existsSync(ownDir()) ? readdirSync(ownDir()) : [])
const userFolderTemps = () => readdirSync(root).filter((name) => name !== 'profile')

// E7: a 5 MB lockfile opened from a remote host could be edited but not saved (720 KB cap).
describe('a staged save', () => {
  const lockfile = '"node_modules/pkg": { "version": "1.0.0" },\n'.repeat(120_000)

  it('round-trips a 5 MB file in place, staging only in the private folder', async () => {
    const target = join(root, 'package-lock.json')
    writeFileSync(target, 'old\n')
    const inode = statSync(target).ino
    const staged = saves()
    const bytes = Buffer.from(lockfile)
    const { saveId } = await staged.begin('conn-1', at(target), bytes.length)
    expect(temps()).toHaveLength(1)
    expect(userFolderTemps()).toEqual(['package-lock.json'])

    await send(staged, 'conn-1', saveId, bytes)
    await expect(
      staged.commit(
        'conn-1',
        saveId,
        { expectedSignature: getDiskBaselineSignature('old\n') },
        same
      )
    ).resolves.toEqual({ ok: true })

    expect(readFileSync(target, 'utf8')).toBe(lockfile)
    // Written in place, like a one-request save: links, owner and xattrs stay.
    expect(statSync(target).ino).toBe(inode)
    expect(temps()).toEqual([])
  })

  it('refuses the commit when the target changed meanwhile, and leaves it as it is', async () => {
    const target = join(root, 'package-lock.json')
    writeFileSync(target, 'old\n')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(target), 4)
    await staged.append('conn-1', saveId, 0, Buffer.from('new\n'))
    writeFileSync(target, 'someone else\n')

    await expect(
      staged.commit(
        'conn-1',
        saveId,
        { expectedSignature: getDiskBaselineSignature('old\n') },
        same
      )
    ).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(readFileSync(target, 'utf8')).toBe('someone else\n')
    expect(temps()).toEqual([])
  })

  it('refuses the commit when the target now resolves to another real file', async () => {
    const target = join(root, 'a.txt')
    writeFileSync(target, 'old')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(target), 3)
    await staged.append('conn-1', saveId, 0, Buffer.from('new'))
    await expect(
      staged.commit('conn-1', saveId, undefined, async () => join(root, 'elsewhere.txt'))
    ).rejects.toThrow('staged_save_target_moved')
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(temps()).toEqual([])
  })

  it('takes chunks only in order and within the declared size, and commits only when complete', async () => {
    const target = join(root, 'a.txt')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(target), 6)
    await expect(staged.append('conn-1', saveId, 3, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await staged.append('conn-1', saveId, 0, Buffer.from('abc'))
    await expect(staged.append('conn-1', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await expect(staged.append('conn-1', saveId, 3, Buffer.from('defg'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await expect(staged.commit('conn-1', saveId, undefined, same)).rejects.toThrow(
      'staged_save_incomplete'
    )
    expect(existsSync(target)).toBe(false)
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

  it('never lets another connection continue, commit or abort a save', async () => {
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(join(root, 'a.txt')), 3)
    await expect(staged.append('conn-2', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_unknown'
    )
    await expect(staged.commit('conn-2', saveId, undefined, same)).rejects.toThrow(
      'staged_save_unknown'
    )
    await staged.abort('conn-2', saveId)
    await staged.abortConnection('conn-2')
    expect(temps()).toHaveLength(1)
  })

  it("drops a closed socket's saves with their temps", async () => {
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', at(join(root, 'a.txt')), 3)
    await staged.begin('conn-1', at(join(root, 'b.txt')), 3)
    await staged.abortConnection('conn-1')
    expect(temps()).toEqual([])
    await expect(staged.append('conn-1', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_unknown'
    )
  })

  it('bounds the size per save, the saves and bytes per connection, and the saves per host', async () => {
    const staged = saves({
      maxBytesPerSave: 10,
      maxSavesPerConnection: 2,
      maxBytesPerConnection: 15,
      maxSavesPerHost: 3
    })
    const target = (name: string) => at(join(root, name))
    await expect(staged.begin('conn-1', target('a'), 11)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-1', target('a'), 10)
    await expect(staged.begin('conn-1', target('b'), 6)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-1', target('b'), 5)
    await expect(staged.begin('conn-1', target('c'), 1)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-2', target('c'), 1)
    await expect(staged.begin('conn-3', target('d'), 1)).rejects.toThrow('staged_save_limit')
  })

  it('drops a save no chunk touched within the idle window, with its temp', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const staged = saves({ idleMs: 1_000 })
    const { saveId } = await staged.begin('conn-1', at(join(root, 'a.txt')), 3)
    await vi.advanceTimersByTimeAsync(999)
    expect(temps()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    await vi.waitFor(() => expect(temps()).toEqual([]))
    await expect(staged.append('conn-1', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_unknown'
    )
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
