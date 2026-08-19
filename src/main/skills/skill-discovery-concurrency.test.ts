import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the regression is measured in filesystem syscalls, not in returned data, so
// the walk's own readdir is what the assertions below count.
const { readdirPaths } = vi.hoisted(() => ({ readdirPaths: [] as string[] }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    readdir: (path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
      readdirPaths.push(String(path))
      return (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest)
    }
  }
})

const { clearSkillRootScanCache, discoverSkills, MAX_LOGGED_ROOT_IDS } = await import('./discovery')

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
}

/** A home with three provider roots populated, plus `paneCount` workspace roots. */
async function buildFixture(
  paneCount: number
): Promise<{ home: string; panes: string[]; noWorkspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-concurrency-'))
  const home = join(root, 'home')
  await writeSkill(join(home, '.agents', 'skills', 'shared'), 'shared')
  await writeSkill(join(home, '.claude', 'skills', 'review'), 'review')
  await writeSkill(join(home, '.codex', 'skills', 'plan'), 'plan')
  const panes: string[] = []
  for (let index = 0; index < paneCount; index += 1) {
    const pane = join(root, `pane-${index}`)
    await writeSkill(join(pane, '.agents', 'skills', `pane-${index}`), `pane-${index}`)
    panes.push(pane)
  }
  // Why: with no cwd the source builder falls back to process.cwd(), which would
  // drag this repo's own skills into every count below.
  return { home, panes, noWorkspace: join(root, 'no-workspace') }
}

// One populated root costs two readdirs per real walk: the root itself, and the
// package directory while looking for SKILL.md. Anything above that is a root
// walked more than once.
const READDIR_CALLS_PER_POPULATED_ROOT = 2

function readdirCountUnder(path: string): number {
  return readdirPaths.filter(
    (candidate) => candidate === path || candidate.startsWith(`${path}${sep}`)
  ).length
}

beforeEach(() => {
  clearSkillRootScanCache()
  readdirPaths.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  clearSkillRootScanCache()
  vi.restoreAllMocks()
})

describe('bounded concurrent skill discovery', () => {
  it('collapses a burst of identical scans into one walk of each root', async () => {
    const { home, noWorkspace } = await buildFixture(0)
    const claudeRoot = join(home, '.claude', 'skills')

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
      )
    )

    expect(results).toHaveLength(32)
    for (const result of results) {
      expect(result.skills.map((skill) => skill.name).sort()).toEqual(['plan', 'review', 'shared'])
    }
    expect(readdirCountUnder(claudeRoot)).toBe(READDIR_CALLS_PER_POPULATED_ROOT)
  })

  it('shares the fixed home roots across panes that only differ by workspace', async () => {
    const { home, panes } = await buildFixture(8)

    const results = await Promise.all(
      panes.flatMap((pane) =>
        Array.from({ length: 4 }, () => discoverSkills({ homeDir: home, repos: [], cwd: pane }))
      )
    )

    expect(results).toHaveLength(32)
    // Every pane still sees the shared home skills plus its own workspace skill.
    for (const [index, result] of results.entries()) {
      const paneIndex = Math.floor(index / 4)
      expect(result.skills.map((skill) => skill.name).sort()).toEqual([
        `pane-${paneIndex}`,
        'plan',
        'review',
        'shared'
      ])
    }
    // The home roots are walked once for all 32 scans; only the per-pane roots repeat.
    expect(readdirCountUnder(join(home, '.agents', 'skills'))).toBe(
      READDIR_CALLS_PER_POPULATED_ROOT
    )
    expect(readdirCountUnder(join(home, '.claude', 'skills'))).toBe(
      READDIR_CALLS_PER_POPULATED_ROOT
    )
    expect(readdirCountUnder(join(home, '.codex', 'skills'))).toBe(READDIR_CALLS_PER_POPULATED_ROOT)
    for (const pane of panes) {
      expect(readdirCountUnder(join(pane, '.agents', 'skills'))).toBe(
        READDIR_CALLS_PER_POPULATED_ROOT
      )
    }
  })

  it('reports missing roots without walking them', async () => {
    const { home, noWorkspace } = await buildFixture(0)

    const result = await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })

    const missing = result.sources.find((source) => source.id === 'home-cursor')
    expect(missing?.exists).toBe(false)
    expect(missing?.skippedReason).toBe('missing')
    expect(readdirCountUnder(join(home, '.cursor', 'skills'))).toBe(0)
  })

  it('re-reads disk when a caller refreshes, and serves the new result afterwards', async () => {
    const { home, noWorkspace } = await buildFixture(0)
    await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    await writeSkill(join(home, '.agents', 'skills', 'added-later'), 'added-later')

    const stale = await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    expect(stale.skills.map((skill) => skill.name)).not.toContain('added-later')

    const refreshed = await discoverSkills({
      homeDir: home,
      repos: [],
      cwd: noWorkspace,
      refresh: true
    })
    expect(refreshed.skills.map((skill) => skill.name)).toContain('added-later')

    // Why: asserting only that the skill is present would pass with no caching at
    // all — the roots would simply re-walk and find it. The refresh has to leave
    // every root cached, or the next scan re-walks the whole set.
    readdirPaths.length = 0
    const afterRefresh = await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    expect(afterRefresh.skills.map((skill) => skill.name)).toContain('added-later')
    expect(readdirPaths).toEqual([])
  })

  it('gives every caller its own arrays so a shared scan cannot be mutated across results', async () => {
    const { home, noWorkspace } = await buildFixture(0)

    const [first, second] = await Promise.all([
      discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace }),
      discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    ])

    const firstShared = first.skills.find((skill) => skill.name === 'shared')
    const secondShared = second.skills.find((skill) => skill.name === 'shared')
    expect(firstShared?.providers).not.toBe(secondShared?.providers)
    expect(firstShared?.rootPaths).not.toBe(secondShared?.rootPaths)
  })

  it('logs the roots it walked, by id, and never a filesystem path', async () => {
    const { home, noWorkspace } = await buildFixture(0)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })

    const line = String(info.mock.calls.at(0)?.at(0))
    // `present` is the signal that separates "big tree" from "big root set", and
    // is not derivable from the other counts.
    expect(line).toContain('[skills] scan roots=23 present=3 walked=23 skills=3')
    expect(line).toContain('home-claude')
    expect(line).not.toContain(home)
    expect(line).not.toContain(tmpdir())
    // The id list is capped so one line cannot grow with the repo count.
    expect(line.slice(line.indexOf('ids=')).split(',')).toHaveLength(MAX_LOGGED_ROOT_IDS)

    info.mockClear()
    await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    // A fully cached scan did no filesystem work, so it must stay silent.
    expect(info).not.toHaveBeenCalled()
  })
})
