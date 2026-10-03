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
    renameSync: vi.fn(actual.renameSync),
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
const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-profile-history-')))
  roots.push(root)
  const profileHome = join(root, 'profile')
  const userHome = join(root, 'user')
  const defaultHome = join(userHome, '.claude')
  fs.mkdirSync(profileHome)
  fs.mkdirSync(defaultHome, { recursive: true })
  const share = (platform?: NodeJS.Platform) =>
    shareClaudeProfileHistory({ profileHome, userHome, platform })
  const history = (): string => fs.readFileSync(join(defaultHome, 'history.jsonl'), 'utf8')
  const scrub = (content: string): void => {
    fs.writeFileSync(join(defaultHome, 'scrubbed'), content)
    fs.renameSync(join(defaultHome, 'scrubbed'), join(defaultHome, 'history.jsonl'))
  }
  const leftovers = (): string[] =>
    fs
      .readdirSync(profileHome)
      .filter((name) => name.startsWith('history.jsonl.orca-profile-merge'))
  return { profileHome, userHome, defaultHome, share, history, scrub, leftovers }
}
afterEach(() => {
  vi.resetAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude profile history sharing', () => {
  it('merges session trees without overwriting conflicts and shares future default writes', async () => {
    const f = fixture()
    for (const home of [f.profileHome, f.defaultHome]) {
      fs.mkdirSync(join(home, 'projects'))
    }
    fs.writeFileSync(join(f.profileHome, 'projects/session.jsonl'), 'new')
    fs.writeFileSync(join(f.profileHome, 'projects/conflict.jsonl'), 'private')
    fs.writeFileSync(join(f.defaultHome, 'projects/conflict.jsonl'), 'existing')
    const report = await f.share()
    expect(report.surfaces.projects).toBe('linked')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'projects', code: 'retained-conflict' })
    )
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('new')
    expect(fs.readFileSync(join(f.defaultHome, 'projects/conflict.jsonl'), 'utf8')).toBe('existing')
    expect(
      fs.readFileSync(join(f.profileHome, 'projects.orca-profile-merge/conflict.jsonl'), 'utf8')
    ).toBe('private')
    fs.writeFileSync(join(f.defaultHome, 'projects/later.jsonl'), 'later')
    expect(fs.readFileSync(join(f.profileHome, 'projects/later.jsonl'), 'utf8')).toBe('later')
  })
  it('recovers a directory swap interrupted before link publication', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'projects.orca-profile-merge'))
    fs.writeFileSync(join(f.profileHome, 'projects.orca-profile-merge/session.jsonl'), 'saved')
    await f.share()
    expect(fs.realpathSync(join(f.profileHome, 'projects'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'projects'))
    )
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('saved')
  })
  it('keeps moving entries past one that fails and reports it', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'todos'))
    for (const name of ['a.json', 'b.json', 'c.json']) {
      fs.writeFileSync(join(f.profileHome, 'todos', name), name)
    }
    const actual = vi.mocked(fs.renameSync).getMockImplementation()!
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('b.json')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      actual(from, to)
    })
    const report = await f.share()
    expect(fs.readdirSync(join(f.defaultHome, 'todos')).sort()).toEqual(['a.json', 'c.json'])
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'todos', code: 'failed' })
    )
    vi.mocked(fs.renameSync).mockReset()
    await f.share()
    expect(fs.readdirSync(join(f.defaultHome, 'todos')).sort()).toEqual([
      'a.json',
      'b.json',
      'c.json'
    ])
  })
  it('keeps a session tree private across filesystems', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'plans'))
    fs.writeFileSync(join(f.profileHome, 'plans/p.md'), 'plan')
    const actual = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation((file, options) => {
      const stats = actual(file, options)
      return file === join(f.profileHome, 'plans') && stats
        ? Object.assign(stats, { dev: -1 })
        : stats
    })
    const report = await f.share()
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'plans', code: 'cross-filesystem' })
    )
    expect(fs.lstatSync(join(f.profileHome, 'plans')).isDirectory()).toBe(true)
    expect(fs.readFileSync(join(f.profileHome, 'plans/p.md'), 'utf8')).toBe('plan')
  })
  it('retains prompt cursors, drains late appends and repairs a CLI replacement', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'default')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'profile\n')
    await f.share()
    const pending = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    fs.appendFileSync(pending, 'late\n')
    await f.share()
    await f.share()
    expect(f.history()).toBe('default\nprofile\nlate\n')
    fs.writeFileSync(join(f.profileHome, 'replacement'), 'replacement\n')
    fs.renameSync(join(f.profileHome, 'replacement'), join(f.profileHome, 'history.jsonl'))
    await f.share()
    expect(fs.realpathSync(join(f.profileHome, 'history.jsonl'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'history.jsonl'))
    )
    expect(f.history()).toBe('default\nprofile\nlate\nreplacement\n')
  })
  it('terminates merged records so the next append starts its own line', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p1\np2')
    await f.share()
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'after-link\n')
    expect(f.history()).toBe('d1\np1\np2\nafter-link\n')
  })
  it('adds only the new lines of a CLI rewrite of the shared file', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const f = fixture()
      fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
      await f.share(platform)
      fs.writeFileSync(join(f.profileHome, 'rewrite'), 'd1\nd2\nnew\n')
      fs.renameSync(join(f.profileHome, 'rewrite'), join(f.profileHome, 'history.jsonl'))
      await f.share(platform)
      expect(f.history()).toBe('d1\nd2\nnew\n')
    }
  })
  it('drains retained generations in numeric order', async () => {
    const f = fixture()
    for (const generation of [0, 1, 2, 10, 11]) {
      const suffix = generation === 0 ? '' : `-${generation}`
      fs.writeFileSync(
        join(f.profileHome, `history.jsonl.orca-profile-merge${suffix}`),
        `g${generation}\n`
      )
    }
    await f.share()
    expect(f.history()).toBe('g0\ng1\ng2\ng10\ng11\n')
  })
  it('never reuses a leftover cursor for a new retained copy', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge.offset'), '18\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'new-1\nnew-2\nnew-3\nnew-4\n')
    await f.share()
    expect(f.history()).toBe('new-1\nnew-2\nnew-3\nnew-4\n')
  })
  it('does not replay a profile file that is already the shared file', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nb\n')
    fs.linkSync(join(f.defaultHome, 'history.jsonl'), join(f.profileHome, 'history.jsonl'))
    await f.share()
    fs.appendFileSync(join(f.defaultHome, 'history.jsonl'), 'c\n')
    await f.share()
    await f.share()
    expect(f.history()).toBe('a\nb\nc\n')
    expect(fs.lstatSync(join(f.profileHome, 'history.jsonl')).isSymbolicLink()).toBe(true)
    expect(f.leftovers()).toEqual([])
  })
  it('drains a copy left by an interrupted share without replaying the shared history', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'd1\nd2\nnew\n')
    await f.share()
    expect(f.history()).toBe('d1\nd2\nnew\n')
  })
  it('removes a leftover name for the shared file so a later scrub stays scrubbed', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    fs.linkSync(
      join(f.defaultHome, 'history.jsonl'),
      join(f.profileHome, 'history.jsonl.orca-profile-merge')
    )
    await f.share()
    expect(f.leftovers()).toEqual([])
    f.scrub('a\nb\n')
    await f.share()
    expect(f.history()).toBe('a\nb\n')
  })
  it('never removes a retained file the default history links to', async () => {
    const f = fixture()
    const kept = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    fs.writeFileSync(kept, 'only\n')
    fs.symlinkSync(kept, join(f.defaultHome, 'history.jsonl'))
    await f.share()
    expect(fs.readFileSync(kept, 'utf8')).toBe('only\n')
    expect(f.history()).toBe('only\n')
  })
  it('still links a session tree when its old leftover cannot be read', async () => {
    const f = fixture()
    const leftover = join(f.profileHome, 'projects.orca-profile-merge')
    fs.mkdirSync(leftover)
    fs.writeFileSync(join(leftover, 's.jsonl'), 'x')
    fs.chmodSync(leftover, 0)
    const report = await f.share()
    fs.chmodSync(leftover, 0o700)
    expect(report.surfaces.projects).toBe('linked')
    expect(report.warnings).toContainEqual(expect.objectContaining({ surface: 'projects' }))
    expect(fs.realpathSync(join(f.profileHome, 'projects'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'projects'))
    )
  })
  it('fails closed on an unreadable Windows link record', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    await f.share('win32')
    const record = join(f.profileHome, 'history.jsonl.orca-profile-link')
    fs.chmodSync(record, 0)
    f.scrub('a\nb\n')
    const report = await f.share('win32')
    fs.chmodSync(record, 0o600)
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'unreadable' })
    )
    expect(f.history()).toBe('a\nb\n')
  })
  it('undoes a Windows link whose record could not be written', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    const report = await f.share('win32')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'link-failed' })
    )
    expect(fs.existsSync(join(f.profileHome, 'history.jsonl'))).toBe(false)
    f.scrub('a\nb\n')
    await f.share('win32')
    expect(f.history()).toBe('a\nb\n')
  })
  it('still links the profile when an old retained copy cannot be read', async () => {
    const f = fixture()
    const old = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    fs.writeFileSync(old, 'old\n')
    fs.chmodSync(old, 0)
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private\n')
    const report = await f.share()
    fs.chmodSync(old, 0o600)
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'unreadable' })
    )
    expect(fs.lstatSync(join(f.profileHome, 'history.jsonl')).isSymbolicLink()).toBe(true)
    expect(f.history()).toBe('private\n')
  })
  it('selects Windows junctions/hardlinks and recognizes an existing hardlink', async () => {
    const f = fixture()
    await f.share('win32')
    expect(fs.linkSync).toHaveBeenCalledWith(
      join(f.defaultHome, 'history.jsonl'),
      join(f.profileHome, 'history.jsonl')
    )
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      join(f.defaultHome, 'projects'),
      join(f.profileHome, 'projects'),
      'junction'
    )
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'one\n')
    await f.share('win32')
    expect(f.history()).toBe('one\n')
  })
  it('does not bring back Windows history the user cleared or rewrote in the default home', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nSECRET\nb\n')
    await f.share('win32')
    fs.writeFileSync(join(f.defaultHome, 'rewrite'), 'a\nb\n')
    fs.renameSync(join(f.defaultHome, 'rewrite'), join(f.defaultHome, 'history.jsonl'))
    const report = await f.share('win32')
    expect(f.history()).toBe('a\nb\n')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'retained-conflict' })
    )
    expect(
      fs.readFileSync(join(f.profileHome, 'history.jsonl.orca-profile-conflict'), 'utf8')
    ).toBe('a\nSECRET\nb\n')
    fs.rmSync(join(f.defaultHome, 'history.jsonl'))
    await f.share('win32')
    await f.share('win32')
    expect(f.history()).toBe('')
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'later\n')
    expect(f.history()).toBe('later\n')
  })
  it('keeps private history with a warning if Windows hardlink publication fails', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private')
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw new Error('unsupported filesystem')
    })
    const report = await f.share('win32')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'history.jsonl', code: 'link-failed' })
    )
    expect(fs.readFileSync(join(f.profileHome, 'history.jsonl'), 'utf8')).toBe('private')
  })
  it('refuses a profile that is or holds a default Claude home', async () => {
    const f = fixture()
    for (const profileHome of [f.defaultHome, join(f.userHome, '.config', 'claude'), f.userHome]) {
      await expect(
        shareClaudeProfileHistory({ profileHome, userHome: f.userHome })
      ).rejects.toThrow('separate directories')
    }
  })
})
