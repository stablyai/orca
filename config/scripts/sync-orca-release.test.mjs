import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { runOrcaReleaseAction } from './sync-orca-release-action.mjs'
import { ORCA_SYNC_BRANCH, selectOrcaRelease, syncOrcaRelease } from './sync-orca-release.mjs'

const NOW = Date.parse('2026-10-12T00:00:00Z')
const AGE = 72 * 60 * 60 * 1000
const release = (tag, age = AGE, extra = {}) => ({
  tag_name: tag,
  published_at: new Date(NOW - age).toISOString(),
  draft: false,
  prerelease: false,
  ...extra
})

describe('Orca release selection', () => {
  it('uses publication time and includes the exact 72-hour boundary', () => {
    const eligible = release('v1.4.223')
    expect(
      selectOrcaRelease(
        [release('v1.4.224', AGE - 1, { created_at: '2020-01-01T00:00:00Z' }), eligible],
        { now: NOW }
      )
    ).toBe(eligible)
  })

  it('selects the highest version regardless of API order or backfilled publication dates', () => {
    const highest = release('v1.10.1', AGE * 3)
    expect(
      selectOrcaRelease([release('v1.9.99'), highest, release('v1.10.0'), release('v1.4.999')], {
        now: NOW
      })
    ).toBe(highest)
  })

  it('excludes mobile, prereleases, drafts, unpublished and malformed versions', () => {
    expect(
      selectOrcaRelease(
        [
          release('mobile-v9.9.9'),
          release('v9.9.9-rc.1'),
          release('v9.9.9', AGE, { draft: true }),
          release('v9.9.8', AGE, { prerelease: true }),
          release('v9.9.7', AGE, { published_at: null }),
          release('v9.9.6', AGE, { published_at: 'invalid' }),
          release('v01.2.3'),
          release('v999999999999999999.2.3'),
          release('v1.2.3', AGE - 1)
        ],
        { now: NOW }
      )
    ).toBeNull()
  })

  it('allows an explicit published stable version to bypass the wait', () => {
    const young = release('v1.4.224', 1)
    expect(selectOrcaRelease([young], { now: NOW, overrideTag: young.tag_name })).toBe(young)
    expect(() => selectOrcaRelease([], { overrideTag: 'main; echo injected' })).toThrow(
      'stable desktop'
    )
    expect(() => selectOrcaRelease([], { overrideTag: 'v1.4.224' })).toThrow('No published')
    expect(() =>
      selectOrcaRelease([release('v1.4.224', 1, { draft: true })], {
        overrideTag: 'v1.4.224'
      })
    ).toThrow('No published')
  })
})

const roots = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture({ keepWorkflows = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phorca-orca-sync-'))
  roots.push(root)
  const hooks = join(root, 'disabled-hooks')
  const globalConfig = join(root, 'empty-git-config')
  writeFileSync(globalConfig, '')
  const command = (cwd, args) => {
    const result = runProcessSync({
      program: 'git',
      args: ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', ...args],
      cwd,
      timeoutMs: 10_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
    })
    return { ...result, exitCode: result.code }
  }
  const checked = (cwd, args) => {
    const result = command(cwd, args)
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    }
    return result.stdout.trim()
  }
  const upstream = join(root, 'orca')
  checked(root, ['init', upstream])
  checked(upstream, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const cwd of [upstream]) {
    checked(cwd, ['config', 'user.name', 'Test'])
    checked(cwd, ['config', 'user.email', 'test@example.com'])
  }
  writeFileSync(join(upstream, 'desktop.txt'), 'old\n')
  const upstreamWorkflows = join(upstream, '.github', 'workflows')
  mkdirSync(upstreamWorkflows, { recursive: true })
  writeFileSync(join(upstreamWorkflows, 'ci.yml'), 'original Orca CI\n')
  writeFileSync(join(upstreamWorkflows, 'deleted-by-orca.yml'), 'keep in Phorca\n')
  writeFileSync(join(upstreamWorkflows, 'removed-by-phorca.yml'), 'removed in Phorca\n')
  checked(upstream, ['add', '.'])
  checked(upstream, ['commit', '-m', 'Initial Orca'])
  checked(upstream, ['tag', 'v1.4.197'])
  const origin = join(root, 'phorca.git')
  checked(root, ['init', '--bare', origin])
  const checkout = join(root, 'checkout')
  checked(root, ['clone', upstream, checkout])
  checked(checkout, ['config', 'user.name', 'Test'])
  checked(checkout, ['config', 'user.email', 'test@example.com'])
  checked(checkout, ['remote', 'set-url', 'origin', origin])
  writeFileSync(join(checkout, 'phorca.txt'), 'Codex and Claude customizations\n')
  const phorcaWorkflows = join(checkout, '.github', 'workflows')
  if (keepWorkflows) {
    writeFileSync(join(phorcaWorkflows, 'ci.yml'), 'Phorca CI\n')
    writeFileSync(join(phorcaWorkflows, 'phorca-only.yml'), 'Phorca sync workflow\n')
    rmSync(join(phorcaWorkflows, 'removed-by-phorca.yml'))
  } else {
    rmSync(phorcaWorkflows, { recursive: true })
  }
  checked(checkout, ['add', '.'])
  checked(checkout, ['commit', '-m', 'Phorca customizations'])
  checked(checkout, ['push', 'origin', 'main'])
  const addRelease = (tag, text) => {
    writeFileSync(join(upstream, 'desktop.txt'), `${text}\n`)
    writeFileSync(join(upstreamWorkflows, 'ci.yml'), `${tag} Orca CI\n`)
    writeFileSync(join(upstreamWorkflows, 'orca-only.yml'), `${tag} upstream workflow\n`)
    rmSync(join(upstreamWorkflows, 'deleted-by-orca.yml'), { force: true })
    checked(upstream, ['add', '.'])
    checked(upstream, ['commit', '-m', `Orca ${tag}`])
    checked(upstream, ['tag', tag])
  }
  addRelease('v1.4.223', 'new')

  const pulls = []
  let releases = [release('v1.4.223')]
  const github = {
    rest: {
      repos: {
        listReleases: vi.fn(),
        getReleaseByTag: vi.fn(async ({ tag }) => ({
          data: releases.find((item) => item.tag_name === tag)
        }))
      },
      pulls: {
        list: vi.fn(),
        create: vi.fn(async (options) => {
          const pull = {
            ...options,
            number: pulls.length + 1,
            state: 'open',
            merged_at: null,
            html_url: `https://github.test/phorca/pull/${pulls.length + 1}`
          }
          pulls.unshift(pull)
          return { data: pull }
        }),
        update: vi.fn(async (options) => {
          Object.assign(
            pulls.find((pull) => pull.number === options.pull_number),
            options
          )
        })
      }
    },
    paginate: vi.fn(async (endpoint) => (endpoint === github.rest.pulls.list ? pulls : releases))
  }
  const git = vi.fn(async (args) =>
    command(
      checkout,
      args.map((arg) => (arg === 'https://github.com/stablyai/orca.git' ? upstream : arg))
    )
  )
  const sync = (options = {}) =>
    syncOrcaRelease({
      github,
      git,
      repo: { owner: 'phocassoftware', repo: 'phorca' },
      base: 'main',
      now: NOW,
      ...options
    })
  const local = (args) => checked(checkout, args)
  const remoteHead = () => checked(origin, ['rev-parse', `refs/heads/${ORCA_SYNC_BRANCH}`])
  const replaceRemote = (tree, parent, message) => {
    const commit = local(['commit-tree', tree, '-p', parent, '-m', message])
    local(['push', '-f', 'origin', `${commit}:refs/heads/${ORCA_SYNC_BRANCH}`])
    return commit
  }
  return {
    checkout,
    upstream,
    pulls,
    github,
    git,
    sync,
    local,
    remoteHead,
    replaceRemote,
    addRelease,
    upstreamGit: (args) => checked(upstream, args),
    setReleases: (items) => {
      releases = items
    }
  }
}

describe('Orca sync with real Git repositories', () => {
  it('rejects a dirty checkout before fetch, push or PR changes', async () => {
    const f = fixture()
    writeFileSync(join(f.checkout, 'untracked.txt'), 'keep this work\n')
    await expect(f.sync()).rejects.toThrow('clean, disposable workflow checkout')
    expect(f.git.mock.calls.map(([args]) => args[0])).toEqual(['status'])
    expect(f.github.rest.pulls.create).not.toHaveBeenCalled()
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
    expect(readFileSync(join(f.checkout, 'untracked.txt'), 'utf8')).toBe('keep this work\n')
  })

  it('does not create an update branch or PR when no release is eligible', async () => {
    const f = fixture()
    f.setReleases([])
    await f.sync()
    expect(f.local(['ls-remote', '--heads', 'origin', `refs/heads/${ORCA_SYNC_BRANCH}`])).toBe('')
    expect(f.pulls).toEqual([])
    expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('old\n')
  })

  it('creates one PR from the release and a merge retains both upstream and Phorca changes', async () => {
    const f = fixture()
    expect(await f.sync()).toContain('Created')
    expect(f.github.rest.pulls.create).toHaveBeenCalledOnce()
    expect(f.pulls[0]).toMatchObject({ base: 'main', head: ORCA_SYNC_BRANCH })
    expect(f.remoteHead()).toBe(f.local(['rev-parse', 'HEAD']))
    expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
      f.local(['rev-parse', 'origin/main:.github/workflows'])
    )
    expect(f.pulls[0].body).toContain("Phorca's workflow files are retained")
    await f.sync()
    expect(f.github.rest.pulls.create).toHaveBeenCalledOnce()
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
    f.local(['checkout', 'main'])
    f.local(['merge', '--no-edit', ORCA_SYNC_BRANCH])
    expect(readFileSync(join(f.checkout, 'phorca.txt'), 'utf8')).toContain('Codex and Claude')
    expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(f.checkout, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe(
      'Phorca CI\n'
    )
    f.local(['push', 'origin', 'main'])
    expect(await f.sync()).toContain('already includes')
  })

  it('advances the same PR while preserving fixes and reviewer notes, then does nothing on reruns', async () => {
    const f = fixture()
    await f.sync()
    writeFileSync(join(f.checkout, 'fix.txt'), 'manual fix\n')
    f.local(['add', '.'])
    f.local(['commit', '-m', 'Manual integration fix'])
    const fix = f.local(['rev-parse', 'HEAD'])
    f.local(['push', 'origin', `HEAD:refs/heads/${ORCA_SYNC_BRANCH}`])
    f.pulls[0].body += '\nReviewer: check this before merging.\n'
    f.addRelease('v1.4.224', 'newest')
    f.setReleases([release('v1.4.224')])
    expect(await f.sync()).toContain('Updated')
    expect(f.local(['merge-base', '--is-ancestor', fix, 'HEAD'])).toBe('')
    expect(f.pulls[0].title).toContain('v1.4.224')
    expect(f.pulls[0].body).toContain('Reviewer: check this before merging.')
    expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
      f.local(['rev-parse', 'origin/main:.github/workflows'])
    )
    expect(f.github.rest.pulls.create).toHaveBeenCalledOnce()
    await f.sync()
    expect(f.github.rest.pulls.update).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'preserves reviewed CI changes on the pending PR (eligible release: %s)',
    async (eligible) => {
      const f = fixture()
      await f.sync()
      writeFileSync(join(f.checkout, '.github', 'workflows', 'ci.yml'), 'Reviewed Phorca CI\n')
      f.local(['add', '.'])
      f.local(['commit', '-m', 'Review CI for the release'])
      f.local(['push', 'origin', `HEAD:refs/heads/${ORCA_SYNC_BRANCH}`])
      const before = f.remoteHead()
      f.addRelease('v1.4.224', 'newest')
      f.setReleases(eligible ? [release('v1.4.224')] : [])
      expect(await f.sync()).toContain('preserve reviewed workflow changes')
      expect(f.remoteHead()).toBe(before)
      expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
    }
  )

  it('preserves the remote branch and existing PR when an update conflicts with manual fixes', async () => {
    const f = fixture()
    await f.sync()
    writeFileSync(join(f.checkout, 'desktop.txt'), 'manual resolution\n')
    f.local(['add', '.'])
    f.local(['commit', '-m', 'Manual resolution'])
    f.local(['push', 'origin', `HEAD:refs/heads/${ORCA_SYNC_BRANCH}`])
    const before = f.remoteHead()
    f.addRelease('v1.4.224', 'conflicting upstream change')
    f.setReleases([release('v1.4.224')])
    await expect(f.sync()).rejects.toThrow('remote branch was preserved')
    expect(f.remoteHead()).toBe(before)
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
    expect(f.local(['status', '--porcelain'])).toBe('')
  })

  it.each([true, false])(
    'pauses after a rejected PR and allows a manual run to reopen it (eligible release: %s)',
    async (eligible) => {
      const f = fixture()
      await f.sync()
      f.setReleases(eligible ? [release('v1.4.223')] : [])
      f.pulls[0].state = 'closed'
      f.git.mockClear()
      expect(await f.sync()).toContain('paused')
      expect(f.git).not.toHaveBeenCalled()
      await f.sync({ manual: true })
      expect(f.pulls[0].state).toBe('open')
      expect(f.github.rest.pulls.create).toHaveBeenCalledOnce()
    }
  )

  it.each([true, false])(
    'starts the next PR after a merge (branch deleted: %s)',
    async (deleted) => {
      const f = fixture()
      await f.sync()
      f.local(['checkout', 'main'])
      f.local(['merge', '--no-edit', ORCA_SYNC_BRANCH])
      const previous = f.remoteHead()
      f.local(['push', 'origin', 'main', ...(deleted ? [`:refs/heads/${ORCA_SYNC_BRANCH}`] : [])])
      f.pulls[0].state = 'closed'
      f.pulls[0].merged_at = '2026-10-12T00:00:00Z'
      f.addRelease('v1.4.224', 'next')
      f.setReleases([release('v1.4.224')])
      expect(await f.sync()).toContain('Created')
      expect(f.pulls.filter((pull) => pull.state === 'open')).toHaveLength(1)
      expect(f.local(['rev-parse', 'HEAD^'])).toBe(
        f.local(['rev-parse', 'refs/remotes/orca-sync/release'])
      )
      expect((await f.git(['merge-base', '--is-ancestor', previous, 'HEAD'])).exitCode).toBe(1)
    }
  )

  it('bypasses the wait only for an explicit tag, and recovers after a failed PR API call', async () => {
    const f = fixture()
    f.setReleases([release('v1.4.223', 1)])
    expect(await f.sync()).toContain('No stable')
    expect(f.git).not.toHaveBeenCalled()
    f.github.rest.pulls.create.mockRejectedValueOnce(new Error('API unavailable'))
    await expect(f.sync({ overrideTag: 'v1.4.223', manual: true })).rejects.toThrow(
      'API unavailable'
    )
    await f.sync({ overrideTag: 'v1.4.223', manual: true })
    expect(f.pulls).toHaveLength(1)
    expect(f.pulls[0].body).toContain('bypassing the 72-hour wait')
  })

  it('repairs stale release details after a successful push and failed PR update without another push', async () => {
    const f = fixture()
    await f.sync()
    f.pulls[0].body += '\nReviewer: keep this note.\n'
    f.addRelease('v1.4.224', 'next')
    f.setReleases([release('v1.4.224')])
    f.github.rest.pulls.update.mockRejectedValueOnce(new Error('API unavailable'))
    await expect(f.sync()).rejects.toThrow('API unavailable')
    expect(f.pulls[0].title).toContain('v1.4.223')
    const pushedHead = f.remoteHead()
    const pushCount = f.git.mock.calls.filter(([args]) => args[0] === 'push').length
    expect(await f.sync()).toContain('Updated')
    expect(f.pulls[0].title).toContain('v1.4.224')
    expect(f.pulls[0].body).toContain('[Orca v1.4.224]')
    expect(f.pulls[0].body).toContain('Reviewer: keep this note.')
    expect(f.remoteHead()).toBe(pushedHead)
    expect(f.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(pushCount)
    await f.sync()
    expect(f.github.rest.pulls.update).toHaveBeenCalledTimes(2)
  })

  it('keeps a manually selected younger release when a later run selects an older candidate', async () => {
    const f = fixture()
    await f.sync()
    f.addRelease('v1.4.224', 'younger')
    f.setReleases([release('v1.4.223'), release('v1.4.224', 1)])
    await f.sync({ manual: true, overrideTag: 'v1.4.224' })
    const body = f.pulls[0].body
    const head = f.remoteHead()
    await f.sync()
    await f.sync({ manual: true, overrideTag: 'v1.4.223' })
    expect(f.pulls[0].title).toContain('v1.4.224')
    expect(f.pulls[0].body).toBe(body)
    expect(f.remoteHead()).toBe(head)
    expect(f.github.rest.pulls.update).toHaveBeenCalledOnce()
  })

  it('keeps a newer manual release on a divergent history while still refreshing workflows', async () => {
    const f = fixture()
    f.addRelease('v1.4.225', 'younger')
    f.setReleases([release('v1.4.225', 1)])
    await f.sync({ manual: true, overrideTag: 'v1.4.225' })
    const body = f.pulls[0].body
    const head = f.remoteHead()
    f.upstreamGit(['checkout', '-b', 'older-line', 'v1.4.223'])
    f.addRelease('v1.4.224', 'divergent older release')
    f.setReleases([release('v1.4.224'), release('v1.4.225', 1)])
    expect(await f.sync()).toContain('v1.4.225')
    expect(f.remoteHead()).toBe(head)
    expect(f.pulls[0].body).toBe(body)
    f.local(['checkout', 'main'])
    writeFileSync(join(f.checkout, '.github', 'workflows', 'ci.yml'), 'Reviewed Phorca CI\n')
    f.local(['add', '.'])
    f.local(['commit', '-m', 'Review Phorca CI'])
    f.local(['push', 'origin', 'main'])
    expect(await f.sync({ manual: true, overrideTag: 'v1.4.224' })).toContain('v1.4.225')
    expect(f.remoteHead()).not.toBe(head)
    expect(f.pulls[0].title).toContain('v1.4.225')
    expect(f.pulls[0].body).toBe(body)
    expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
      f.local(['rev-parse', 'origin/main:.github/workflows'])
    )
    expect(
      (await f.git(['merge-base', '--is-ancestor', 'refs/remotes/orca-sync/release', 'HEAD']))
        .exitCode
    ).toBe(1)
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
  })

  it('requires repair instead of replacing a missing newer update branch or its release markers', async () => {
    const f = fixture()
    f.addRelease('v1.4.224', 'younger')
    f.setReleases([release('v1.4.223'), release('v1.4.224', 1)])
    await f.sync({ manual: true, overrideTag: 'v1.4.224' })
    const body = f.pulls[0].body
    for (const previous of [
      'Reviewer note without markers',
      '<!-- orca-sync:end -->\n<!-- orca-sync:start -->\nReviewer note'
    ]) {
      f.pulls[0].body = previous
      f.git.mockClear()
      await expect(f.sync()).rejects.toThrow('running manually with tag v1.4.224')
      expect(f.git).not.toHaveBeenCalled()
    }
    f.pulls[0].body = body
    f.local(['push', 'origin', `:refs/heads/${ORCA_SYNC_BRANCH}`])
    f.git.mockClear()
    await expect(f.sync()).rejects.toThrow('Restore the update branch')
    expect(
      f.git.mock.calls.some(([args]) => ['checkout', 'commit', 'push'].includes(args[0]))
    ).toBe(false)
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
  })

  it.each([
    'Reviewer note',
    '<!-- orca-sync:start -->\nReviewer note',
    '<!-- orca-sync:end -->\nReviewer note'
  ])('repairs missing PR description markers without losing %s', async (previous) => {
    const f = fixture()
    await f.sync()
    f.pulls[0].body = previous
    const head = f.remoteHead()
    await f.sync()
    expect(f.pulls[0].body).toContain('[Orca v1.4.223]')
    expect(f.pulls[0].body).toContain(previous)
    expect(f.remoteHead()).toBe(head)
    await f.sync()
    expect(f.github.rest.pulls.update).toHaveBeenCalledOnce()
  })

  it('refuses to overwrite a human push that races the sync push', async () => {
    const f = fixture()
    await f.sync()
    const previous = f.remoteHead()
    f.addRelease('v1.4.224', 'next')
    f.setReleases([release('v1.4.224')])
    const tree = f.local(['rev-parse', 'HEAD^{tree}'])
    const human = f.local(['commit-tree', tree, '-p', previous, '-m', 'Concurrent human fix'])
    const git = async (args) => {
      if (args[0] === 'push') {
        f.local(['push', 'origin', `${human}:refs/heads/${ORCA_SYNC_BRANCH}`])
      }
      return f.git(args)
    }
    await expect(f.sync({ git })).rejects.toThrow('git push failed')
    expect(f.remoteHead()).toBe(human)
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled()
  })

  it('continues from a non-fast-forward replacement of the update branch', async () => {
    const f = fixture()
    await f.sync()
    const previous = f.remoteHead()
    await f.sync()
    expect(f.local(['rev-parse', 'refs/remotes/orca-sync/previous'])).toBe(previous)
    const rewritten = f.replaceRemote(`${previous}^{tree}`, `${previous}^`, 'Rewritten branch')
    f.addRelease('v1.4.224', 'next')
    f.setReleases([release('v1.4.224')])
    expect(await f.sync()).toContain('the branch includes Orca v1.4.224')
    f.local(['merge-base', '--is-ancestor', rewritten, f.remoteHead()])
    expect(f.pulls).toHaveLength(1)
    expect(f.pulls[0].title).toContain('v1.4.224')
  })

  it('requires repair when the update branch no longer contains the newer described release', async () => {
    const f = fixture()
    f.addRelease('v1.4.224', 'younger')
    f.setReleases([release('v1.4.223'), release('v1.4.224', 1)])
    await f.sync({ manual: true, overrideTag: 'v1.4.224' })
    const body = f.pulls[0].body
    const replaced = f.replaceRemote('origin/main^{tree}', 'origin/main', 'Branch without Orca')
    await expect(f.sync()).rejects.toThrow("no longer contains the PR's Orca v1.4.224")
    expect(f.remoteHead()).toBe(replaced)
    expect(f.pulls[0].body).toBe(body)
    expect(await f.sync({ manual: true, overrideTag: 'v1.4.224' })).toContain(
      'the branch includes Orca v1.4.224'
    )
    f.local(['merge-base', '--is-ancestor', 'refs/remotes/orca-sync/release', f.remoteHead()])
  })

  it('keeps retired tests deleted while other upstream scripts and tests continue updating', async () => {
    const f = fixture()
    const retiredTests = JSON.parse(
      readFileSync(new URL('../phorca-retired-tests.json', import.meta.url), 'utf8')
    )
    const retainedPaths = [
      'config/scripts/assert-github-release-is-draft.mjs',
      'config/scripts/new-upstream.test.mjs',
      'config/scripts/new-upstream.test.ts'
    ]
    mkdirSync(join(f.upstream, 'config', 'scripts'), { recursive: true })
    const updateScripts = (version) => {
      for (const path of [...retiredTests, ...retainedPaths]) {
        writeFileSync(join(f.upstream, path), `${version}: ${path}\n`)
      }
    }
    updateScripts('first')
    f.addRelease('v1.4.224', 'first source update')
    f.setReleases([release('v1.4.224')])
    await f.sync()
    expect(f.local(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'config/scripts'])).toBe(
      [...retainedPaths].sort().join('\n')
    )

    updateScripts('second')
    f.addRelease('v1.4.225', 'second source update')
    f.setReleases([release('v1.4.225')])
    await f.sync()
    expect(f.local(['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expect(f.local(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'config/scripts'])).toBe(
      [...retainedPaths].sort().join('\n')
    )
    for (const path of retainedPaths) {
      expect(readFileSync(join(f.checkout, path), 'utf8')).toBe(`second: ${path}\n`)
    }
    expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('second source update\n')
    const head = f.remoteHead()
    await f.sync()
    expect(f.remoteHead()).toBe(head)

    f.local(['checkout', 'main'])
    f.local(['merge', '--no-edit', ORCA_SYNC_BRANCH])
    expect(f.local(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'config/scripts'])).toBe(
      [...retainedPaths].sort().join('\n')
    )
  })

  it.each([true, false])(
    'refreshes retired tests and workflows on an existing PR (eligible release: %s)',
    async (eligible) => {
      const f = fixture()
      await f.sync()
      f.pulls[0].body += '\nReviewer note: keep the manual integration fix.\n'
      const title = f.pulls[0].title
      const body = f.pulls[0].body
      const retiredTest = 'config/scripts/assert-github-release-is-draft.test.mjs'
      mkdirSync(join(f.checkout, 'config', 'scripts'), { recursive: true })
      writeFileSync(join(f.checkout, retiredTest), 'Test from an older sync policy\n')
      f.local(['add', retiredTest])
      f.local(['commit', '-m', 'Keep a test from the older sync policy'])
      f.local(['push', 'origin', ORCA_SYNC_BRANCH])
      const oldHead = f.remoteHead()

      f.local(['checkout', 'main'])
      writeFileSync(join(f.checkout, '.github', 'workflows', 'ci.yml'), 'Current Phorca CI\n')
      f.local(['add', '.github/workflows'])
      f.local(['commit', '-m', 'Update the default branch workflow policy'])
      f.local(['push', 'origin', 'main'])
      f.setReleases(eligible ? [release('v1.4.223')] : [])

      await f.sync()
      expect(f.remoteHead()).not.toBe(oldHead)
      expect(f.local(['ls-tree', '--name-only', 'HEAD', '--', retiredTest])).toBe('')
      expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
        f.local(['rev-parse', 'origin/main:.github/workflows'])
      )
      expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('new\n')
      expect(f.pulls[0].title).toBe(title)
      expect(f.pulls[0].body).toBe(body)
      const refreshed = f.remoteHead()
      await f.sync()
      expect(f.remoteHead()).toBe(refreshed)
    }
  )

  it('excludes upstream workflows even when Phorca has removed the whole workflow directory', async () => {
    const f = fixture({ keepWorkflows: false })
    await f.sync()
    expect(f.local(['ls-tree', '--name-only', 'HEAD', '--', '.github/workflows'])).toBe('')
    f.addRelease('v1.4.224', 'next')
    f.setReleases([release('v1.4.224')])
    await f.sync()
    expect(f.local(['ls-tree', '--name-only', 'HEAD', '--', '.github/workflows'])).toBe('')
    expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('next\n')
  })

  it.each([false, true])(
    'keeps only sync after workflow retirement and later releases (previous release merged: %s)',
    async (merged) => {
      const f = fixture()
      await f.sync()
      if (merged) {
        f.local(['checkout', 'main'])
        f.local(['merge', '--no-edit', ORCA_SYNC_BRANCH])
        f.local(['push', 'origin', 'main'])
        f.pulls[0].state = 'closed'
        f.pulls[0].merged_at = '2026-10-12T00:00:00Z'
        f.addRelease('v1.4.224', 'younger')
        f.setReleases([release('v1.4.223'), release('v1.4.224', 1)])
        await f.sync({ manual: true, overrideTag: 'v1.4.224' })
      }
      const title = f.pulls[0].title
      const body = f.pulls[0].body
      const previous = f.remoteHead()
      f.local(['checkout', 'main'])
      const workflows = join(f.checkout, '.github', 'workflows')
      rmSync(workflows, { recursive: true })
      mkdirSync(workflows, { recursive: true })
      writeFileSync(join(workflows, 'sync-orca-release.yml'), 'Phorca release sync\n')
      f.local(['add', '.'])
      f.local(['commit', '-m', 'Retire every workflow except release sync'])
      f.local(['push', 'origin', 'main'])
      await f.sync()
      expect(f.remoteHead()).not.toBe(previous)
      expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
        f.local(['rev-parse', 'origin/main:.github/workflows'])
      )
      expect(f.local(['ls-tree', '-r', '--name-only', 'HEAD', '--', '.github/workflows'])).toBe(
        '.github/workflows/sync-orca-release.yml'
      )
      expect(readFileSync(join(workflows, 'sync-orca-release.yml'), 'utf8')).toBe(
        'Phorca release sync\n'
      )
      expect(f.github.rest.pulls.create).toHaveBeenCalledTimes(merged ? 2 : 1)
      expect(f.pulls[0].title).toBe(title)
      expect(f.pulls[0].body).toBe(body)
      const refreshed = f.remoteHead()
      await f.sync()
      expect(f.remoteHead()).toBe(refreshed)

      writeFileSync(
        join(f.upstream, '.github', 'workflows', 'another-upstream.yaml'),
        'New upstream workflow\n'
      )
      f.addRelease('v1.4.225', 'next source update')
      f.setReleases([release('v1.4.225')])
      await f.sync()
      expect(readFileSync(join(f.checkout, 'desktop.txt'), 'utf8')).toBe('next source update\n')
      expect(f.local(['rev-parse', 'HEAD:.github/workflows'])).toBe(
        f.local(['rev-parse', 'origin/main:.github/workflows'])
      )
      f.local(['checkout', 'main'])
      f.local(['merge', '--no-edit', ORCA_SYNC_BRANCH])
      expect(f.local(['ls-tree', '-r', '--name-only', 'HEAD', '--', '.github/workflows'])).toBe(
        '.github/workflows/sync-orca-release.yml'
      )
      const updated = f.remoteHead()
      await f.sync()
      expect(f.remoteHead()).toBe(updated)
    }
  )
})

describe('Orca release action', () => {
  it.each(['refs/heads/feature', 'refs/tags/v1.4.224'])(
    'rejects manual runs from %s before Git or API calls',
    async (ref) => {
      const exec = { getExecOutput: vi.fn() }
      const github = { paginate: vi.fn() }
      const context = { ref, payload: { repository: { default_branch: 'main' } } }
      await expect(runOrcaReleaseAction({ github, exec, context, core: {} })).rejects.toThrow(
        'must run from the default branch'
      )
      expect(exec.getExecOutput).not.toHaveBeenCalled()
      expect(github.paginate).not.toHaveBeenCalled()
    }
  )

  it('runs a manual release override from the default branch and reports the result', async () => {
    const f = fixture()
    f.setReleases([release('v1.4.223', 1)])
    vi.stubEnv('RUNNER_TEMP', f.checkout)
    vi.stubEnv('OVERRIDE_TAG', 'v1.4.223')
    const exec = { getExecOutput: vi.fn(async (_program, args) => f.git(args.slice(4))) }
    const summary = { addRaw: vi.fn().mockReturnThis(), write: vi.fn() }
    const core = { info: vi.fn(), summary }
    const context = {
      ref: 'refs/heads/main',
      eventName: 'workflow_dispatch',
      repo: { owner: 'phocassoftware', repo: 'phorca' },
      payload: { repository: { default_branch: 'main' } }
    }
    await runOrcaReleaseAction({ github: f.github, exec, context, core })
    expect(f.github.rest.repos.getReleaseByTag).toHaveBeenCalledWith({
      owner: 'stablyai',
      repo: 'orca',
      tag: 'v1.4.223'
    })
    expect(exec.getExecOutput).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        `core.hooksPath=${join(f.checkout, 'orca-sync-disabled-hooks')}`,
        'commit.gpgSign=false'
      ]),
      { ignoreReturnCode: true, silent: true }
    )
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Created'))
    expect(summary.addRaw).toHaveBeenCalledWith(expect.stringContaining('Created'))
    expect(summary.write).toHaveBeenCalledOnce()
  })
})
