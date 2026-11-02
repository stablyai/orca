import { describe, expect, it } from 'vitest'

import type { SkillScanRoot } from './skill-discovery-sources'
import { parseWslSkillDiscoveryOutput } from './skill-discovery-wsl'

const homeRoot: SkillScanRoot = {
  id: 'home-codex',
  label: 'Codex home',
  path: '/home/alice/.codex/skills',
  sourceKind: 'home',
  providers: ['codex'],
  owner: 'codex'
}
const repoRoot: SkillScanRoot = {
  id: 'repo-agents',
  label: 'Repo project .agents',
  path: '/work/project/.agents/skills',
  sourceKind: 'repo',
  providers: ['agent-skills'],
  owner: null
}

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

describe('WSL skill discovery', () => {
  it('parses distro-native metadata and deduplicates canonical skill paths', () => {
    const markdown = Buffer.from(
      '---\nname: Review\ndescription: Review this change\n---\n',
      'utf8'
    ).toString('base64')
    const output = [
      record('R', '0', '1'),
      record('R', '1', '0'),
      record(
        'S',
        '0',
        '/home/alice/.codex/skills/.system/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000000',
        markdown
      ),
      record(
        'S',
        '1',
        '/work/project/.agents/skills/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000001',
        markdown
      )
    ].join('')

    const result = parseWslSkillDiscoveryOutput(output, [homeRoot, repoRoot], 42)

    expect(result.scannedAt).toBe(42)
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'Review',
        description: 'Review this change',
        sourceKind: 'bundled',
        rootPath: homeRoot.path,
        skillFilePath: '/home/alice/.codex/skills/.system/review/SKILL.md',
        updatedAt: 1_700_000_000_000
      })
    ])
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'home-codex', exists: true }),
        expect.objectContaining({ id: 'repo-agents', exists: false, skippedReason: 'missing' })
      ])
    )
  })

  it('uses the TypeScript summary parser for uncertain WSL name candidates', () => {
    const blockName = Buffer.from('\uFEFF---\nname: >-\n  Agent\n  Orchestration\n---\n').toString(
      'base64'
    )
    const headingName = Buffer.from('# Computer Use\n\nUse the computer.\n').toString('base64')
    const output = [
      record('R', '0', '1'),
      record(
        'S',
        '0',
        '/home/alice/.agents/skills/renamed-a/SKILL.md',
        '/home/alice/.agents/skills/renamed-a/SKILL.md',
        '1700000000',
        blockName
      ),
      record(
        'S',
        '0',
        '/home/alice/.agents/skills/renamed-b/SKILL.md',
        '/home/alice/.agents/skills/renamed-b/SKILL.md',
        '1700000000',
        headingName
      )
    ].join('')

    expect(
      parseWslSkillDiscoveryOutput(
        output,
        [homeRoot],
        42,
        ['home'],
        ['agent orchestration', 'computer use']
      ).skills.map((skill) => skill.name)
    ).toEqual(['Agent Orchestration', 'Computer Use'])
  })
})
