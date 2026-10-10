import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FsUtils from '../codex-accounts/fs-utils'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    statSync: vi.fn(actual.statSync),
    symlinkSync: vi.fn(actual.symlinkSync)
  }
})
vi.mock('../codex-accounts/fs-utils', async (original) => {
  const actual = await original<typeof FsUtils>()
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) }
})
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { shareClaudeProfileHistory } from './claude-profile-history'

// Junctions and hardlinks need no Windows privilege, so these run on real Windows too; on POSIX
// Node ignores the junction type and makes a symlink.
const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-profile-history-win-')))
  roots.push(root)
  const profileHome = join(root, 'profile')
  const userHome = join(root, 'user')
  const defaultHome = join(userHome, '.claude')
  fs.mkdirSync(profileHome)
  fs.mkdirSync(defaultHome, { recursive: true })
  const share = () => shareClaudeProfileHistory({ profileHome, userHome, platform: 'win32' })
  const history = (): string => fs.readFileSync(join(defaultHome, 'history.jsonl'), 'utf8')
  const isHardlinked = (): boolean => {
    const own = fs.lstatSync(join(profileHome, 'history.jsonl'), { bigint: true })
    const shared = fs.lstatSync(join(defaultHome, 'history.jsonl'), { bigint: true })
    return !own.isSymbolicLink() && own.dev === shared.dev && own.ino === shared.ino
  }
  const scrub = (content: string): void => {
    fs.writeFileSync(join(defaultHome, 'scrubbed'), content)
    fs.renameSync(join(defaultHome, 'scrubbed'), join(defaultHome, 'history.jsonl'))
  }
  return { profileHome, defaultHome, share, history, isHardlinked, scrub }
}
afterEach(() => {
  vi.resetAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude profile history sharing on Windows', () => {
  it('links session trees as junctions and prompt history as a hardlink', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'projects'))
    fs.writeFileSync(join(f.profileHome, 'projects/session.jsonl'), 'own')
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p1\n')
    const report = await f.share()
    expect(report.warnings).toEqual([])
    expect(report.surfaces.projects).toBe('linked')
    expect(report.surfaces['history.jsonl']).toBe('linked')
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      join(f.defaultHome, 'projects'),
      join(f.profileHome, 'projects'),
      'junction'
    )
    // Node reports a junction as a symlink.
    expect(fs.lstatSync(join(f.profileHome, 'projects')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('own')
    expect(f.isHardlinked()).toBe(true)
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'p2\n')
    expect(f.history()).toBe('d1\np1\np2\n')
    const again = await f.share()
    expect(again.surfaces.projects).toBe('unchanged')
    expect(again.surfaces['history.jsonl']).toBe('unchanged')
    expect(f.history()).toBe('d1\np1\np2\n')
  })
  it('adds only the new lines when the CLI rewrites the profile copy', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
    await f.share()
    fs.writeFileSync(join(f.profileHome, 'rewrite'), 'd1\nd2\nnew\n')
    fs.renameSync(join(f.profileHome, 'rewrite'), join(f.profileHome, 'history.jsonl'))
    await f.share()
    expect(f.history()).toBe('d1\nd2\nnew\n')
    expect(f.isHardlinked()).toBe(true)
  })
  it('does not bring back history the user removed from the shared file', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    await f.share()
    f.scrub('a\nb\n')
    const report = await f.share()
    expect(f.history()).toBe('a\nb\n')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'retained-conflict' })
    )
    expect(
      fs.readFileSync(join(f.profileHome, 'history.jsonl.orca-profile-conflict'), 'utf8')
    ).toBe('a\nSECRET\nb\n')
    expect(f.isHardlinked()).toBe(true)
    await f.share()
    expect(f.history()).toBe('a\nb\n')
  })
  it('fails closed when the link record cannot be read', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    await f.share()
    const record = join(f.profileHome, 'history.jsonl.orca-profile-link')
    fs.rmSync(record)
    fs.mkdirSync(record)
    f.scrub('a\nb\n')
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'unreadable' })
    )
    expect(f.history()).toBe('a\nb\n')
  })
  it('keeps prompt history private across volumes and moves nothing', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private\n')
    const actual = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation((file, options) => {
      const stats = actual(file, options)
      return file === f.profileHome && stats ? Object.assign(stats, { dev: -1 }) : stats
    })
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'cross-filesystem' })
    )
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl'), 'utf8')).toBe('private\n')
    expect(fs.readdirSync(f.profileHome).filter((name) => name.startsWith('history'))).toEqual([
      'history.jsonl'
    ])
    expect(f.history()).toBe('')
  })
  it('leaves a set-aside copy in place when the share is refused across volumes', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'saved\n')
    const actual = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation((file, options) => {
      const stats = actual(file, options)
      return file === f.profileHome && stats ? Object.assign(stats, { dev: -1 }) : stats
    })
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'cross-filesystem' })
    )
    expect(f.history()).toBe('d1\n')
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'utf8')).toBe(
      'saved\n'
    )
  })
  it('keeps prompt history private when the hardlink cannot be made', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private\n')
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('not supported'), { code: 'EPERM' })
    })
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'link-failed' })
    )
    expect(fs.lstatSync(join(f.profileHome, 'history.jsonl')).nlink).toBe(1)
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl'), 'utf8')).toBe('private\n')
  })
  it('undoes a hardlink whose record could not be written', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private\n')
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'link-failed' })
    )
    expect(f.isHardlinked()).toBe(false)
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl'), 'utf8')).toBe('private\n')
  })
  it('finishes a share that was interrupted before the links were made', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'd1\nsaved\n')
    fs.mkdirSync(join(f.profileHome, 'todos.orca-profile-merge'))
    fs.writeFileSync(join(f.profileHome, 'todos.orca-profile-merge/t.json'), 't')
    const report = await f.share()
    expect(report.warnings).toEqual([])
    expect(f.history()).toBe('d1\nsaved\n')
    expect(f.isHardlinked()).toBe(true)
    expect(fs.readFileSync(join(f.defaultHome, 'todos/t.json'), 'utf8')).toBe('t')
    expect(fs.realpathSync(join(f.profileHome, 'todos'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'todos'))
    )
  })
})
