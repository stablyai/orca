import { beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ run: vi.fn(), plugins: vi.fn(async () => []) }))
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: io.run }))
vi.mock('./claude-plugin-skill-sources-wsl', () => ({
  discoverClaudePluginSkillSourcesInWsl: io.plugins
}))
vi.mock('./discovery', () => ({ clearSkillRootScanCache: vi.fn(), discoverSkills: vi.fn() }))
import { clearSkillDiscoveryCaches, discoverSkillsOnTarget } from './skill-discovery-target'

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
it('does not cache failed scans as an empty successful observation', async () => {
  io.run.mockResolvedValueOnce({ code: 1, timedOut: false, stdout: '', stderr: 'failure' })
  const req = { ...target, names: ['alias-a'], sourceKinds: ['home' as const] }
  await expect(discoverSkillsOnTarget(req, [])).rejects.toThrow('skill-discovery-wsl-scan-failed')
  expect((await discoverSkillsOnTarget(req, [])).skills).toHaveLength(1)
  expect(io.run).toHaveBeenCalledTimes(2)
})
