import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    statSync: vi.fn(actual.statSync)
  }
})
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
  const share = (platform: NodeJS.Platform = 'linux') =>
    shareClaudeProfileHistory({ profileHome, userHome, platform })
  const history = (): string => fs.readFileSync(join(defaultHome, 'history.jsonl'), 'utf8')
  return { profileHome, userHome, defaultHome, share, history }
}
afterEach(() => {
  vi.resetAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Why: these create real symlinks, which Windows needs privilege for.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude profile history sharing', () => {
  itLinks(
    'merges session trees without overwriting conflicts and shares future default writes',
    async () => {
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
      expect(fs.readFileSync(join(f.defaultHome, 'projects/conflict.jsonl'), 'utf8')).toBe(
        'existing'
      )
      expect(
        fs.readFileSync(join(f.profileHome, 'projects.orca-profile-merge/conflict.jsonl'), 'utf8')
      ).toBe('private')
      fs.writeFileSync(join(f.defaultHome, 'projects/later.jsonl'), 'later')
      expect(fs.readFileSync(join(f.profileHome, 'projects/later.jsonl'), 'utf8')).toBe('later')
    }
  )
  itLinks('recovers a directory swap interrupted before link publication', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'projects.orca-profile-merge'))
    fs.writeFileSync(join(f.profileHome, 'projects.orca-profile-merge/session.jsonl'), 'saved')
    await f.share()
    expect(fs.realpathSync(join(f.profileHome, 'projects'))).toBe(
      fs.realpathSync(join(f.defaultHome, 'projects'))
    )
    expect(fs.readFileSync(join(f.defaultHome, 'projects/session.jsonl'), 'utf8')).toBe('saved')
  })
  itLinks('keeps moving entries past one that fails and reports it', async () => {
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
  itLinks('keeps a session tree private across filesystems', async () => {
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
  itLinks('retains prompt cursors, drains late appends and repairs a CLI replacement', async () => {
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
  itLinks('terminates merged records so the next append starts its own line', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\n')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p1\np2')
    await f.share()
    fs.appendFileSync(join(f.profileHome, 'history.jsonl'), 'after-link\n')
    expect(f.history()).toBe('d1\np1\np2\nafter-link\n')
  })
  itLinks('adds only the new lines of a CLI rewrite of the shared file', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
    await f.share()
    fs.writeFileSync(join(f.profileHome, 'rewrite'), 'd1\nd2\nnew\n')
    fs.renameSync(join(f.profileHome, 'rewrite'), join(f.profileHome, 'history.jsonl'))
    await f.share()
    expect(f.history()).toBe('d1\nd2\nnew\n')
  })
  itLinks(
    'does not re-append lines after a purge drops one the shared file still has',
    async () => {
      const f = fixture()
      fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'a\nb\nc\n')
      await f.share()
      fs.writeFileSync(join(f.profileHome, 'rewrite'), 'a\nc\n')
      fs.renameSync(join(f.profileHome, 'rewrite'), join(f.profileHome, 'history.jsonl'))
      await f.share()
      expect(f.history()).toBe('a\nb\nc\n')
    }
  )
  itLinks('deletes a retained copy once a later run finds nothing new in it', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p1\n')
    await f.share()
    const pending = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    expect(fs.existsSync(`${pending}.offset`)).toBe(true)
    fs.appendFileSync(pending, 'late\n')
    await f.share()
    expect(fs.existsSync(pending)).toBe(true)
    await f.share()
    expect(fs.existsSync(pending)).toBe(false)
    expect(fs.existsSync(`${pending}.offset`)).toBe(false)
    expect(f.history()).toBe('p1\nlate\n')
  })
  itLinks('drains retained generations in numeric order', async () => {
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
  itLinks(
    'drains a copy left by an interrupted share without replaying the shared history',
    async () => {
      const f = fixture()
      fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
      fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'd1\nd2\nnew\n')
      await f.share()
      expect(f.history()).toBe('d1\nd2\nnew\n')
    }
  )
  itLinks('still links a session tree when its old leftover cannot be read', async () => {
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
  itLinks('still links the profile when an old retained copy cannot be read', async () => {
    const f = fixture()
    const old = join(f.profileHome, 'history.jsonl.orca-profile-merge')
    fs.writeFileSync(old, 'old\n')
    fs.chmodSync(old, 0)
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'private\n')
    const report = await f.share()
    fs.chmodSync(old, 0o600)
    expect(report.warnings).toContainEqual(expect.objectContaining({ surface: 'history.jsonl' }))
    expect(fs.lstatSync(join(f.profileHome, 'history.jsonl')).isSymbolicLink()).toBe(true)
    expect(f.history()).toBe('private\n')
  })
  itLinks("pools into the user's own CLAUDE_CONFIG_DIR when they set one", async () => {
    const f = fixture()
    const userConfigDir = join(f.userHome, 'custom-claude')
    fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p1\n')
    await shareClaudeProfileHistory({
      profileHome: f.profileHome,
      userHome: f.userHome,
      userConfigDir,
      platform: 'linux'
    })
    expect(fs.realpathSync(join(f.profileHome, 'projects'))).toBe(join(userConfigDir, 'projects'))
    expect(fs.readFileSync(join(userConfigDir, 'history.jsonl'), 'utf8')).toBe('p1\n')
    expect(fs.readdirSync(f.defaultHome)).toEqual([])
  })
})
