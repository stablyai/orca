import { describe, expect, it } from 'vitest'
import type { SkillScanRoot } from './skill-discovery-sources'
import { buildWslSkillDiscoveryCommand, parseWslSkillDiscoveryOutput } from './skill-discovery-wsl'

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

  it('builds a distro-side scan for enumeration, reads, and canonical identity', () => {
    const script = buildWslSkillDiscoveryCommand([
      { ...repoRoot, path: "/work/alice's project/.agents/skills" }
    ])

    expect(script).toContain('find -L "$root_path"')
    expect(script).toContain('realpath -- "$skill_file"')
    expect(script).toContain('head -c 262144 -- "$skill_file"')
    expect(script).toContain(`'/work/alice'\\''s project/.agents/skills'`)
  })

  it('filters requested names before reading skill payloads', () => {
    const command = buildWslSkillDiscoveryCommand([homeRoot], ['Orchestration', 'computer-use'])
    const encoded = /printf %s '([^']+)'/.exec(command)?.[1]
    const script = Buffer.from(encoded!, 'base64').toString('utf8')

    expect(script).toContain("'orchestration'|'computer-use') return 0")
    expect(script).toContain('local normalized_name=${1,,}')
    expect(script).toContain('metadata_name_known=0')
    expect(script).toContain('bytes_read=$((bytes_read + ${#line} + 1))')
    expect(script).toContain('[ "$bytes_read" -gt 262144 ] && return')
    expect(script).toContain("line=${line#$'\\xEF\\xBB\\xBF'}")
    expect(script).toContain('if [ "$metadata_name_known" -eq 1 ]; then')
    expect(script).toContain('done < "$1"')
    expect(script).not.toContain("awk '")
    expect(script).not.toContain("tr '[:upper:]'")
    expect(script.indexOf('matches_requested_name "$metadata_name" || continue')).toBeLessThan(
      script.indexOf('encoded_markdown=$(head')
    )
  })

  it('filters classified source kinds while parsing', () => {
    const markdown = Buffer.from('---\nname: Bundled\n---\n').toString('base64')
    const output = [
      record('R', '0', '1'),
      record(
        'S',
        '0',
        '/home/alice/.codex/skills/.system/bundled/SKILL.md',
        '/home/alice/.codex/skills/.system/bundled/SKILL.md',
        '1700000000',
        '1',
        markdown
      )
    ].join('')

    expect(parseWslSkillDiscoveryOutput(output, [homeRoot], 42, ['home']).skills).toEqual([])
    expect(parseWslSkillDiscoveryOutput(output, [homeRoot], 42, []).skills).toHaveLength(1)
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
        '1',
        blockName
      ),
      record(
        'S',
        '0',
        '/home/alice/.agents/skills/renamed-b/SKILL.md',
        '/home/alice/.agents/skills/renamed-b/SKILL.md',
        '1700000000',
        '1',
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

  it('rejects malformed host responses instead of reporting an empty scan', () => {
    expect(() => parseWslSkillDiscoveryOutput(record('S', '9'), [homeRoot])).toThrow(
      'unknown source'
    )
  })
})
