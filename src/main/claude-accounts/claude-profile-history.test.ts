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

// Real symlinks require additional privileges on Windows.
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
  itLinks(
    "keeps Claude's live sessions per folder and undoes an earlier build's link",
    async () => {
      const f = fixture()
      fs.mkdirSync(join(f.defaultHome, 'sessions'))
      fs.writeFileSync(join(f.defaultHome, 'sessions/123.json'), 'default daemon')
      fs.symlinkSync(join(f.defaultHome, 'sessions'), join(f.profileHome, 'sessions'))
      expect((await f.share()).surfaces.sessions).toBe('synced')
      expect(fs.existsSync(join(f.profileHome, 'sessions'))).toBe(false)
      expect(fs.readFileSync(join(f.defaultHome, 'sessions/123.json'), 'utf8')).toBe(
        'default daemon'
      )
      fs.mkdirSync(join(f.profileHome, 'sessions'))
      expect((await f.share()).surfaces.sessions).toBe('unchanged')
      expect(fs.lstatSync(join(f.profileHome, 'sessions')).isSymbolicLink()).toBe(false)
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
})
