import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import type * as WslUncAccessGateModule from '../wsl/wsl-unc-access-gate'

type GateState = 'stopped' | 'unverifiable' | 'running'

const mocks = vi.hoisted(() => {
  const touched: string[] = []
  const gate: { state: GateState } = { state: 'stopped' }
  return { touched, wslRepoRoot: '', gate, blockedWslDistroForPath: vi.fn() }
})

// Record every path the scan touches so a stopped distro's repo can be proven untouched.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const record =
    <A extends unknown[], R>(fn: (path: string, ...rest: A) => R) =>
    (path: string, ...rest: A): R => {
      mocks.touched.push(String(path))
      return fn(path, ...rest)
    }
  return {
    ...actual,
    stat: record(actual.stat),
    realpath: record(actual.realpath),
    readdir: record(actual.readdir),
    open: record(actual.open)
  }
})
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGateModule>()),
  // Off Windows no path maps to a distro; stand in for the WSL project's UNC root.
  wslDistroForPath: (path: string) =>
    mocks.wslRepoRoot && path.startsWith(mocks.wslRepoRoot) ? 'Ubuntu' : null,
  blockedWslDistroForPath: mocks.blockedWslDistroForPath
}))

import { clearSkillRootScanCache, discoverSkills } from './discovery'

function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 1, kind: 'git' }
}

describe('skill discovery for a stopped WSL distro (E9)', () => {
  let root = ''
  let hostRepo = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-skill-wsl-stopped-'))
    mocks.wslRepoRoot = join(root, 'wsl-repo')
    hostRepo = join(root, 'host-repo')
    for (const repoPath of [mocks.wslRepoRoot, hostRepo]) {
      const skill = join(repoPath, '.agents', 'skills', 'repo-skill')
      await mkdir(skill, { recursive: true })
      await writeFile(
        join(skill, 'SKILL.md'),
        `# Skill in ${repoPath === hostRepo ? 'host' : 'wsl'}\n`
      )
    }
    mocks.touched = []
    clearSkillRootScanCache()
    mocks.blockedWslDistroForPath.mockReset()
    mocks.blockedWslDistroForPath.mockImplementation(async () =>
      mocks.gate.state === 'running' ? null : { distro: 'Ubuntu', state: mocks.gate.state }
    )
  })

  afterEach(async () => {
    mocks.gate.state = 'stopped'
    await rm(root, { recursive: true, force: true })
  })

  async function discover() {
    return discoverSkills({
      homeDir: join(root, 'home'),
      repos: [repo('wsl', mocks.wslRepoRoot), repo('host', hostRepo)],
      includeCwd: false,
      sourceKinds: ['repo']
    })
  }

  it.each(['stopped', 'unverifiable'] as const)(
    'leaves a %s distro’s repo folders out without reading them, and scans host repos as before',
    async (state) => {
      mocks.gate.state = state
      const result = await discover()

      expect(mocks.touched.filter((path) => path.startsWith(mocks.wslRepoRoot))).toEqual([])
      // Reported unavailable, never read and never 'missing', so no surface shows them as absent.
      const wslSources = result.sources.filter((source) =>
        source.path.startsWith(mocks.wslRepoRoot)
      )
      expect(wslSources.length).toBeGreaterThan(0)
      expect(wslSources.every((source) => source.skippedReason === 'unavailable')).toBe(true)
      expect(wslSources.every((source) => !source.exists)).toBe(true)
      expect(result.skills.map((skill) => skill.name)).toEqual(['Skill in host'])
      // One gate check per distro, not per folder.
      expect(mocks.blockedWslDistroForPath).toHaveBeenCalledTimes(1)
    }
  )

  it('never asks the WSL gate when no root or cwd is on a distro', async () => {
    const result = await discoverSkills({
      homeDir: join(root, 'home'),
      repos: [repo('host', hostRepo)],
      cwd: hostRepo,
      sourceKinds: ['repo', 'plugin']
    })
    expect(mocks.blockedWslDistroForPath).not.toHaveBeenCalled()
    expect(result.skills.map((skill) => skill.name)).toEqual(['Skill in host'])
  })

  it('reports a stopped workspace’s plugin folder unavailable instead of listing it', async () => {
    const result = await discoverSkills({
      homeDir: join(root, 'home'),
      repos: [],
      cwd: mocks.wslRepoRoot,
      sourceKinds: ['plugin']
    })
    expect(mocks.touched.filter((path) => path.startsWith(mocks.wslRepoRoot))).toEqual([])
    // The workspace's own plugin folder is unavailable; host plugin roots answer as usual.
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        sourceKind: 'plugin',
        path: mocks.wslRepoRoot,
        skippedReason: 'unavailable'
      })
    )
  })

  it('lets Share read only the stopped roots holding the chosen skills, leaving the rest down', async () => {
    const chosen = join(mocks.wslRepoRoot, '.agents', 'skills', 'repo-skill')
    const result = await discoverSkills({
      homeDir: join(root, 'home'),
      repos: [repo('wsl', mocks.wslRepoRoot), repo('host', hostRepo)],
      includeCwd: false,
      sourceKinds: ['repo'],
      readStoppedWslRootsFor: [chosen]
    })
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'Skill in host',
      'Skill in wsl'
    ])
    const chosenRoot = join(mocks.wslRepoRoot, '.agents', 'skills')
    // The chosen skill's root is read; the distro's other roots stay unread and unavailable.
    const otherWslTouches = mocks.touched.filter(
      (path) => path.startsWith(mocks.wslRepoRoot) && !path.startsWith(chosenRoot)
    )
    expect(otherWslTouches).toEqual([])
    const otherWslSources = result.sources.filter(
      (source) => source.path.startsWith(mocks.wslRepoRoot) && source.path !== chosenRoot
    )
    expect(otherWslSources.length).toBeGreaterThan(0)
    expect(otherWslSources.every((source) => source.skippedReason === 'unavailable')).toBe(true)
  })

  it("lets Share read every stopped root when it can't name the skills' folders", async () => {
    const result = await discoverSkills({
      homeDir: join(root, 'home'),
      repos: [repo('wsl', mocks.wslRepoRoot), repo('host', hostRepo)],
      includeCwd: false,
      sourceKinds: ['repo'],
      readStoppedWslRootsFor: 'all'
    })
    expect(mocks.blockedWslDistroForPath).not.toHaveBeenCalled()
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'Skill in host',
      'Skill in wsl'
    ])
  })

  it('scans a running distro’s repo folders, so the next scan after a wake picks them up', async () => {
    await discover()
    mocks.gate.state = 'running'
    const result = await discover()
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'Skill in host',
      'Skill in wsl'
    ])
    expect(
      result.sources.find((source) => source.path === join(mocks.wslRepoRoot, '.agents', 'skills'))
    ).toMatchObject({ exists: true })
  })
})
