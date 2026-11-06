import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count readdir syscalls: unchanged results alone cannot prove scan reuse.
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

const { clearSkillRootScanCache, discoverSkills } = await import('./discovery')

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
}

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
  // Supply cwd or discovery would scan this repo and pollute fixture counts.
  return { home, panes, noWorkspace: join(root, 'no-workspace') }
}

beforeEach(() => {
  clearSkillRootScanCache()
  readdirPaths.length = 0
  // Isolate HERMES_HOME so developer installs cannot change present-root counts.
  vi.stubEnv('HERMES_HOME', '')
  vi.stubEnv('LOCALAPPDATA', '')
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  clearSkillRootScanCache()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('bounded concurrent skill discovery', () => {
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

    // Presence alone does not prove caching; the scan after refresh must perform no new walks.
    readdirPaths.length = 0
    const afterRefresh = await discoverSkills({ homeDir: home, repos: [], cwd: noWorkspace })
    expect(afterRefresh.skills.map((skill) => skill.name)).toContain('added-later')
    expect(readdirPaths).toEqual([])
  })
})
