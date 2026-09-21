import { beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ run: vi.fn(), plugins: vi.fn(async () => []) }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: io.run }))
vi.mock('./claude-plugin-skill-sources-wsl', () => ({
  discoverClaudePluginSkillSourcesInWsl: io.plugins
}))
vi.mock('./discovery', () => ({ clearSkillRootScanCache: vi.fn(), discoverSkills: vi.fn() }))
import { clearSkillDiscoveryCaches, discoverSkillsOnTarget } from './skill-discovery-target'
import {
  readWslSkillDiscoveryObservation,
  projectWslSkillDiscovery
} from './skill-discovery-wsl-observation'
import type { SkillScanRoot } from './skill-discovery-sources'
const target = { kind: 'wsl' as const, distro: 'Ubuntu', homeDir: '/home/test', cwd: '/repo' }
const record = (...fields: string[]) => `${fields.join('\0')}\0`
const encoded = Buffer.from('---\nname: shared-frontmatter\ndescription: Fixture\n---\n').toString(
  'base64'
)
const common = '/opt/physical/SKILL.md'
const rows = [
  record('S', '0', '/home/test/.codex/skills/.system/bundle/SKILL.md', common, '1', encoded),
  record('S', '0', '/home/test/.codex/skills/alias-a/SKILL.md', common, '1', encoded),
  record('S', '1', '/home/test/.agents/skills/alias-b/SKILL.md', common, '1', encoded),
  ...Array.from({ length: 6 }, (_, i) =>
    record(
      'S',
      '0',
      `/home/test/.codex/skills/skill-${i}/SKILL.md`,
      `/physical/skill-${i}/SKILL.md`,
      '1',
      encoded
    )
  )
]
const output = record('R', '0', '1') + record('R', '1', '1') + rows.join('')
beforeEach(() => {
  clearSkillDiscoveryCaches()
  io.run.mockReset()
  io.plugins.mockClear()
  io.run.mockResolvedValue({ code: 0, timedOut: false, stdout: output, stderr: '' })
})
it('keeps both home aliases when a bundled canonical duplicate appears first', async () => {
  const [a, b, bundle] = await Promise.all([
    discoverSkillsOnTarget({ ...target, names: ['alias-a'], sourceKinds: ['home'] }, []),
    discoverSkillsOnTarget({ ...target, names: ['alias-b'], sourceKinds: ['home'] }, []),
    discoverSkillsOnTarget({ ...target, names: ['bundle'], sourceKinds: ['bundled'] }, [])
  ])
  expect(io.run).toHaveBeenCalledTimes(1)
  expect(a.skills.map((s) => s.directoryPath)).toEqual(['/home/test/.codex/skills/alias-a'])
  expect(b.skills.map((s) => s.directoryPath)).toEqual(['/home/test/.agents/skills/alias-b'])
  expect(bundle.skills.map((s) => s.directoryPath)).toEqual([
    '/home/test/.codex/skills/.system/bundle'
  ])
  expect(a.skills[0].providers).toEqual(['codex'])
  expect(b.skills[0].providers).toEqual(['agent-skills'])
  expect(a.skills[0].id).toBe(b.skills[0].id)
  expect(a.skills[0].sourceKind).toBe('home')
})
it('six distinct installed-name checks share one scan and retain all six answers', async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      discoverSkillsOnTarget({ ...target, names: [`skill-${i}`], sourceKinds: ['home'] }, [])
    )
  )
  expect(io.run).toHaveBeenCalledTimes(1)
  expect(results.map((r) => r.skills[0]?.directoryPath)).toEqual(
    Array.from({ length: 6 }, (_, i) => `/home/test/.codex/skills/skill-${i}`)
  )
  expect(io.run.mock.calls[0][0].timeoutMs).toBe(10000)
  expect(io.run.mock.calls[0][0].script).not.toContain('matches_requested_name')
  expect(io.run.mock.calls[0][0].script).not.toContain("'/repo/")
  expect(io.plugins).not.toHaveBeenCalled()
})
it('cache projections do not contaminate later aliases or source metadata', async () => {
  const first = await discoverSkillsOnTarget(
    { ...target, names: ['alias-a'], sourceKinds: ['home'] },
    []
  )
  first.skills[0].providers.push('claude')
  first.skills[0].rootPaths!.push('/poison')
  first.sources[0].providers.push('claude')
  const later = await discoverSkillsOnTarget(
    { ...target, names: ['alias-a'], sourceKinds: ['home'] },
    []
  )
  expect(later.skills[0].providers).toEqual(['codex'])
  expect(later.skills[0].rootPaths).toEqual(['/home/test/.codex/skills'])
  expect(later.sources[0].providers).not.toContain('claude')
  expect(io.run).toHaveBeenCalledTimes(1)
})
it('refresh, cache clear, distro and broader root requirements are isolated', async () => {
  const req = { ...target, names: ['alias-a'], sourceKinds: ['home' as const] }
  await discoverSkillsOnTarget(req, [])
  await discoverSkillsOnTarget({ ...req, names: ['alias-b'] }, [])
  expect(io.run).toHaveBeenCalledTimes(1)
  await discoverSkillsOnTarget(req, [], { refresh: true })
  clearSkillDiscoveryCaches()
  await discoverSkillsOnTarget(req, [])
  await discoverSkillsOnTarget({ ...req, distro: 'Other' }, [])
  await discoverSkillsOnTarget({ ...target, names: ['alias-a'] }, [])
  expect(io.run).toHaveBeenCalledTimes(5)
  expect(io.plugins).toHaveBeenCalledTimes(1)
})
it('deduplicates and merges only eligible alias roots, independently of row order', () => {
  const roots: SkillScanRoot[] = [
    {
      id: 'home',
      label: 'Home',
      path: '/home/test/.codex/skills',
      sourceKind: 'home',
      providers: ['codex'],
      owner: 'codex'
    },
    {
      id: 'home2',
      label: 'Home2',
      path: '/home/test/.agents/skills',
      sourceKind: 'home',
      providers: ['agent-skills'],
      owner: null
    }
  ]
  for (const records of [rows, rows.toReversed()]) {
    const obs = readWslSkillDiscoveryObservation(records.join(''), roots, 42)
    const a = projectWslSkillDiscovery(obs, ['home'], ['alias-a'])
    const b = projectWslSkillDiscovery(obs, ['home'], ['alias-b'])
    expect(a.skills).toHaveLength(1)
    expect(b.skills).toHaveLength(1)
    expect(a.skills[0].providers).toEqual(['codex'])
    expect(b.skills[0].providers).toEqual(['agent-skills'])
    const both = projectWslSkillDiscovery(obs, ['home'], ['alias-a', 'alias-b'])
    expect(both.skills).toHaveLength(1)
    expect(new Set(both.skills[0].providers)).toEqual(new Set(['codex', 'agent-skills']))
    const all = projectWslSkillDiscovery(obs)
    expect(all.skills).toHaveLength(7)
    expect(all.scannedAt).toBe(42)
  }
})
it('does not cache failed scans as an empty successful observation', async () => {
  io.run.mockResolvedValueOnce({ code: 1, timedOut: false, stdout: '', stderr: 'failure' })
  const req = { ...target, names: ['alias-a'], sourceKinds: ['home' as const] }
  await expect(discoverSkillsOnTarget(req, [])).rejects.toThrow('skill-discovery-wsl-scan-failed')
  expect((await discoverSkillsOnTarget(req, [])).skills).toHaveLength(1)
  expect(io.run).toHaveBeenCalledTimes(2)
})
