import { loadHistoryFilesystem } from '../../shared/history-filesystem'
import { observeHistoryFilesystem } from '../../shared/history-filesystem-test-boundary'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    statSync: vi.fn(actual.statSync),
    symlinkSync: vi.fn(actual.symlinkSync)
  }
})
import { shareClaudeProfileHistory } from './claude-profile-history'
import { mergeClaudeProfilePromptHistory } from './claude-profile-prompt-history'
import { createClaudeProfileReport } from './claude-profile-report'
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
  // Copies waiting to merge, each in its claim directory beside its cursor.
  const staged = (): string[] =>
    fs
      .readdirSync(profileHome)
      .filter((name) => name.startsWith('history.jsonl.orca-profile-claim-'))
      .map((name) => join(profileHome, name, 'history.jsonl'))
      .filter((path) => fs.existsSync(path))
  return { profileHome, userHome, defaultHome, share, history, staged }
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
    const [pending] = f.staged()
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
    const [pending] = f.staged()
    expect(fs.existsSync(join(dirname(pending), 'offset'))).toBe(true)
    fs.appendFileSync(pending, 'late\n')
    await f.share()
    expect(fs.existsSync(pending)).toBe(true)
    await f.share()
    expect(fs.existsSync(dirname(pending))).toBe(false)
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
    "merges an older build's unmarked copy, retires a merged marked one and keeps the rest aside unimported",
    async () => {
      const f = fixture()
      fs.writeFileSync(join(f.defaultHome, 'history.jsonl'), 'd1\nd2\n')
      fs.writeFileSync(join(f.profileHome, 'history.jsonl.orca-profile-merge'), 'd1\nd2\nnew\n')
      // The marker may belong to an earlier copy under this name, and the user may have deleted
      // what it says was imported.
      const marked = join(f.profileHome, 'history.jsonl.orca-profile-merge-1')
      fs.writeFileSync(marked, 'd1\ndeleted\n')
      fs.writeFileSync(`${marked}.offset`, '11\n')
      // What an older build leaves after every staging setup: drained, every line shared.
      const leftover = join(f.profileHome, 'history.jsonl.orca-profile-merge-2')
      fs.writeFileSync(leftover, 'd1\nd2\n')
      fs.writeFileSync(`${leftover}.offset`, '6\n')
      const report = await f.share()
      expect(f.history()).toBe('d1\nd2\nnew\n')
      expect(report.warnings).toEqual([
        expect.objectContaining({ surface: 'history.jsonl', code: 'retained-conflict' })
      ])
      const kept = join(f.profileHome, 'history.jsonl.orca-profile-conflict')
      expect(fs.readFileSync(kept, 'utf8')).toBe('d1\ndeleted\n')
      expect(fs.existsSync(leftover)).toBe(false)
      expect(fs.existsSync(`${kept}-1`)).toBe(false)
      await f.share()
      expect(f.history()).toBe('d1\nd2\nnew\n')
      expect(fs.existsSync(`${marked}.offset`)).toBe(false)
      expect(fs.existsSync(`${leftover}.offset`)).toBe(false)
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

  // A rival claimed the original and published its link after this setup's check, so this
  // setup stages the rival's link; `republish` has the rival publish again before it is retired.
  const rivalRace = async (republish: boolean) => {
    const f = fixture(),
      source = join(f.profileHome, 'history.jsonl')
    fs.writeFileSync(source, 'private\n')
    const rival = join(f.profileHome, 'history.jsonl.orca-profile-claim-rival')
    const stop = observeHistoryFilesystem(loadHistoryFilesystem(), (operation, path, args) => {
      if (
        operation === 'move' &&
        path === f.profileHome &&
        args[0] === 'history.jsonl' &&
        !fs.existsSync(rival)
      ) {
        fs.mkdirSync(rival)
        fs.renameSync(source, join(rival, 'history.jsonl'))
        fs.symlinkSync(join(f.defaultHome, 'history.jsonl'), source)
      } else if (republish && operation === 'unlink' && path.startsWith(`${source}.`)) {
        republish = false
        fs.symlinkSync(join(f.defaultHome, 'history.jsonl'), source)
      }
    })
    const report = await f.share().finally(stop)
    expect(report.warnings).toEqual([])
    expect(f.staged()).toEqual([join(rival, 'history.jsonl')])
    expect(
      fs
        .readdirSync(f.profileHome)
        .filter((name) => name.startsWith('history'))
        .sort()
    ).toEqual(['history.jsonl', 'history.jsonl.orca-profile-claim-rival'])
    expect(fs.realpathSync(source)).toBe(fs.realpathSync(join(f.defaultHome, 'history.jsonl')))
    await f.share()
    expect(f.history()).toBe('private\n')
    return report.surfaces['history.jsonl']
  }
  itLinks("retires a rival's staged link and keeps the rival's original", async () => {
    expect(await rivalRace(false)).toBe('linked')
  })
  itLinks('settles as shared when a rival publishes again before its link is retired', async () => {
    expect(await rivalRace(true)).toBe('unchanged')
  })

  itLinks(
    'keeps both prompt files when a new one appears before a failed link is undone',
    async () => {
      const f = fixture(),
        source = join(f.profileHome, 'history.jsonl')
      fs.writeFileSync(source, 'private\n')
      vi.mocked(fs.symlinkSync).mockImplementationOnce(() => {
        fs.writeFileSync(source, 'native\n')
        throw Object.assign(new Error('publication denied'), { code: 'EACCES' })
      })
      const report = await f.share()
      expect(report.surfaces['history.jsonl']).toBe('failed')
      expect(report.warnings).toContainEqual(
        expect.objectContaining({ surface: 'history.jsonl', code: 'retained-conflict' })
      )
      expect(fs.readFileSync(source, 'utf8')).toBe('native\n')
      expect(f.staged().map((file) => fs.readFileSync(file, 'utf8'))).toEqual(['private\n'])
      await f.share()
      expect(f.history()).toBe('private\nnative\n')
    }
  )
  itLinks('merges into a link another setup published while this one failed', async () => {
    const f = fixture(),
      source = join(f.profileHome, 'history.jsonl')
    fs.writeFileSync(source, 'private\n')
    vi.mocked(fs.symlinkSync).mockImplementationOnce((target, path) => {
      fs.symlinkSync(target, path)
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    })
    const report = await f.share()
    expect(report.surfaces['history.jsonl']).toBe('unchanged')
    expect(report.warnings).toEqual([])
    expect(f.history()).toBe('private\n')
  })

  itLinks('a stale cursor write cannot reach a new copy claimed under a reused name', async () => {
    const f = fixture()
    const claim = join(f.profileHome, 'history.jsonl.orca-profile-claim-0000000000000000')
    const fill = (content: string) => {
      fs.mkdirSync(claim)
      fs.writeFileSync(join(claim, 'history.jsonl'), content)
    }
    const merge = () =>
      mergeClaudeProfilePromptHistory(
        f.profileHome,
        f.defaultHome,
        'linux',
        createClaudeProfileReport()
      )
    // A claimed copy an interrupted setup left behind.
    fill('old-1\n')
    let reused = false
    const stop = observeHistoryFilesystem(loadHistoryFilesystem(), (operation, path) => {
      if (!reused && operation === 'write' && path === claim) {
        reused = true
        // Before this drain records its cursor, later setups merge and retire the copy, and a
        // new copy of equal length is claimed under the same name.
        merge()
        merge()
        expect(fs.existsSync(claim)).toBe(false)
        fill('new-2\n')
      }
    })
    try {
      await f.share()
    } finally {
      stop()
    }
    expect(reused).toBe(true)
    expect(fs.readdirSync(claim)).toEqual(['history.jsonl'])
    expect(fs.readFileSync(join(claim, 'history.jsonl'), 'utf8')).toBe('new-2\n')
    await f.share()
    await f.share()
    expect(f.history()).toBe('old-1\nnew-2\n')
    expect(fs.existsSync(claim)).toBe(false)
  })

  itLinks('leaves no leftover population that grows with completed races', async () => {
    const after = async (races: number) => {
      const f = fixture()
      fs.writeFileSync(join(f.profileHome, 'history.jsonl'), 'p\n')
      await f.share()
      for (let race = 1; race <= races; race++) {
        // What completed races leave: a moved-aside link, a cursor whose copy another setup
        // retired, and a late cursor in a retired claim.
        const pending = join(f.profileHome, 'history.jsonl.orca-profile-merge')
        fs.symlinkSync(join(f.defaultHome, 'history.jsonl'), `${pending}-${race}`)
        fs.writeFileSync(`${pending}-${races + race}.offset`, '2\n')
        const claim = join(f.profileHome, `history.jsonl.orca-profile-claim-${race}`)
        fs.mkdirSync(claim)
        fs.writeFileSync(join(claim, 'offset'), '2\n')
      }
      await f.share()
      expect(f.history()).toBe('p\n')
      return fs.readdirSync(f.profileHome).sort()
    }
    const few = await after(5)
    expect(await after(50)).toEqual(few)
    expect(few.filter((name) => name.startsWith('history.jsonl'))).toEqual(['history.jsonl'])
  })
})
