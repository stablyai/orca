import { loadHistoryFilesystem } from '../../shared/history-filesystem'
import { observeHistoryFilesystem } from '../../shared/history-filesystem-test-boundary'
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
    const restore = observeHistoryFilesystem(
      loadHistoryFilesystem(),
      (operation, _parent, args) => {
        if (operation === 'move' && args[0] === 'b.json') {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
      }
    )
    const report = await f.share().finally(restore)
    expect(fs.readdirSync(join(f.defaultHome, 'todos')).sort()).toEqual(['a.json', 'c.json'])
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'todos', code: 'failed' })
    )
    expect(report.warnings).not.toContainEqual(
      expect.objectContaining({ surface: 'todos', code: 'retained-conflict' })
    )
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
    // The native answer for directories on different devices.
    const restore = observeHistoryFilesystem(loadHistoryFilesystem(), (operation) =>
      operation === 'sameDevice' ? false : undefined
    )
    try {
      const report = await f.share()
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ surface: 'plans', code: 'cross-filesystem' })
      )
      expect(fs.lstatSync(join(f.profileHome, 'plans')).isDirectory()).toBe(true)
      expect(fs.readFileSync(join(f.profileHome, 'plans/p.md'), 'utf8')).toBe('plan')
    } finally {
      restore()
    }
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

describe('consuming publication interleavings with the actual addon', () => {
  it('retains two concurrent same-name variants and never promotes a source subtree into shared', async () => {
    const f = fixture(),
      other = join(f.userHome, 'other-profile')
    fs.mkdirSync(other)
    for (const [home, text] of [
      [f.profileHome, 'A'],
      [other, 'B']
    ]) {
      fs.mkdirSync(join(home, 'projects', 'nested'), { recursive: true })
      fs.writeFileSync(join(home, 'projects', 'nested', 'entry'), text)
    }
    const { mergeClaudeProfileDirectory } = await import('./claude-profile-history')
    const { createClaudeProfileReport } = await import('./claude-profile-report')
    let rival = false
    const moved: string[] = []
    const stop = observeHistoryFilesystem(loadHistoryFilesystem(), (operation, path, args) => {
      if (operation !== 'move') {
        return
      }
      moved.push(String(args[0]))
      if (
        !rival &&
        path === join(f.profileHome, 'projects.orca-profile-merge', 'nested') &&
        args[0] === 'entry'
      ) {
        rival = true
        mergeClaudeProfileDirectory(
          other,
          f.defaultHome,
          'projects',
          process.platform,
          createClaudeProfileReport()
        )
      }
    })
    try {
      const report = await f.share()
      expect(rival).toBe(true)
      expect(moved).not.toContain('nested')
      expect(fs.readFileSync(join(f.defaultHome, 'projects', 'nested', 'entry'), 'utf8')).toBe('B')
      expect(
        fs.readFileSync(
          join(f.profileHome, 'projects.orca-profile-merge', 'nested', 'entry'),
          'utf8'
        )
      ).toBe('A')
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ surface: 'projects', code: 'retained-conflict' })
      )
    } finally {
      stop()
    }
  })

  it('does not follow a reused pending pathname while its original directory is open', async () => {
    const f = fixture(),
      pending = join(f.profileHome, 'projects.orca-profile-merge')
    const old = join(f.profileHome, 'opened-pending'),
      s0 = join(f.userHome, 's0')
    fs.mkdirSync(pending)
    fs.mkdirSync(s0)
    fs.writeFileSync(join(pending, 'original'), 'A')
    fs.writeFileSync(join(s0, 'never-drain'), 'S0')
    let reused = false
    const stop = observeHistoryFilesystem(loadHistoryFilesystem(), (operation, path) => {
      if (!reused && operation === 'entries' && path === pending) {
        reused = true
        fs.renameSync(pending, old)
        fs.symlinkSync(s0, pending, process.platform === 'win32' ? 'junction' : 'dir')
      }
    })
    try {
      await f.share()
      expect(reused).toBe(true)
      expect(fs.readFileSync(join(s0, 'never-drain'), 'utf8')).toBe('S0')
      expect(fs.readFileSync(join(f.defaultHome, 'projects', 'original'), 'utf8')).toBe('A')
      expect(fs.existsSync(join(f.defaultHome, 'projects', 'never-drain'))).toBe(false)
      expect(fs.lstatSync(pending).isSymbolicLink()).toBe(true)
    } finally {
      stop()
    }
  })

  it('collects merge-back conflicts when native recreates the private root before a failed link', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.profileHome, 'projects'))
    fs.writeFileSync(join(f.profileHome, 'projects', 'entry'), 'A')
    let denied = false
    const stop = observeHistoryFilesystem(loadHistoryFilesystem(), (operation, path, args) => {
      if (!denied && operation === 'link' && path === f.profileHome && args[0] === 'projects') {
        denied = true
        fs.mkdirSync(join(f.profileHome, 'projects'))
        fs.writeFileSync(join(f.profileHome, 'projects', 'entry'), 'B')
        throw Object.assign(new Error('publication denied'), { code: 'EACCES' })
      }
    })
    try {
      const report = await f.share()
      expect(report.surfaces.projects).toBe('failed')
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ surface: 'projects', code: 'retained-conflict' })
      )
      expect(fs.readFileSync(join(f.profileHome, 'projects', 'entry'), 'utf8')).toBe('B')
      expect(
        fs.readFileSync(join(f.profileHome, 'projects.orca-profile-merge', 'entry'), 'utf8')
      ).toBe('A')
    } finally {
      stop()
    }
  })
})
