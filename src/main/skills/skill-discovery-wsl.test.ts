import { describe, expect, it, vi } from 'vitest'
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

  it('rejects malformed host responses instead of reporting an empty scan', () => {
    expect(() => parseWslSkillDiscoveryOutput(record('S', '9'), [homeRoot])).toThrow(
      'unknown source'
    )
  })
})

it('reuses one source collator while preserving locale, lexical numbers, and stable ties', () => {
  const labels = Array.from(
    { length: 200 },
    (_, index) =>
      ['éclair', 'Eclair', 'item2', 'item10', 'Ångström', 'zebra', 'İstanbul'][index % 7]
  )
  const roots = labels.map((label, index) => ({ ...homeRoot, id: String(index), label }))
  const expected = [...roots].sort((a, b) =>
    // oxlint-disable-next-line sort-comparator-performance/no-repeated-collator -- Preserve the old comparator as the parity oracle.
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  )
  const NativeCollator = Intl.Collator
  const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
    return new NativeCollator(locales, options)
  })
  const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
  try {
    const result = parseWslSkillDiscoveryOutput('', roots, 42)
    expect(result.sources.map((source) => source.id)).toEqual(expected.map((root) => root.id))
    expect(construct).toHaveBeenCalledExactlyOnceWith(undefined, { sensitivity: 'base' })
    expect(localeCompare).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})
