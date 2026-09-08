import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSkillDiscoveryResult, SKILL_DISCOVERY_LIMITS } from '../../shared/skills'
import { discoverSkills } from './discovery'

async function scanFixture() {
  const home = await mkdtemp(join(tmpdir(), 'orca-skills-wire-'))
  const skillDir = join(home, '.agents', 'skills', 'docs')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: Docs\ndescription: Writes docs\n---\n')
  return discoverSkills({ homeDir: home, repos: [], includeCwd: false })
}

describe('skill discovery wire contract', () => {
  /**
   * The schema is a hand-maintained copy of DiscoveredSkill/SkillDiscoverySource,
   * and `z.object` strips unknown keys — so a field added to either type is
   * dropped on every SSH scan with no other test failing. This sends a real scan
   * through the wire exactly as the relay does (JSON round trip, then parse) and
   * compares deep equality, so a stripped field fails here.
   */
  it('round-trips a real scan without dropping or altering a field', async () => {
    const scanned = await scanFixture()
    expect(scanned.skills.length).toBeGreaterThan(0)

    const overWire = JSON.parse(JSON.stringify(scanned))
    const parsed = parseSkillDiscoveryResult(overWire)

    expect(parsed.skills).toEqual(scanned.skills)
    expect(parsed.sources).toEqual(scanned.sources)
    expect(parsed.scannedAt).toBe(scanned.scannedAt)
  })

  // Belt and braces on the same invariant: `toEqual` above ignores keys whose
  // value is undefined, so it would not notice the schema dropping an optional
  // field. Comparing key sets catches that. The baseline is the JSON-encoded
  // scan rather than the scan object, because the wire itself drops
  // undefined-valued keys (`skippedReason` on a root that exists).
  it('keeps every key that survives the wire', async () => {
    const scanned = await scanFixture()
    const overWire = JSON.parse(JSON.stringify(scanned))
    const parsed = parseSkillDiscoveryResult(overWire)

    expect(Object.keys(parsed.skills[0]).sort()).toEqual(Object.keys(overWire.skills[0]).sort())
    expect(Object.keys(parsed.sources[0]).sort()).toEqual(Object.keys(overWire.sources[0]).sort())
  })

  it('accepts every skippedReason the scanner can emit', () => {
    for (const skippedReason of ['missing', 'remote-repo', 'unavailable'] as const) {
      expect(() =>
        parseSkillDiscoveryResult({
          skills: [],
          sources: [
            {
              id: 'source-1',
              label: 'Claude',
              path: '/home/remote/.claude/skills',
              sourceKind: 'home',
              providers: ['claude'],
              owner: 'claude',
              exists: false,
              skippedReason
            }
          ],
          scannedAt: 1
        })
      ).not.toThrow()
    }
  })

  it('clamps oversized remote display text instead of failing the scan', () => {
    const parsed = parseSkillDiscoveryResult({
      skills: [
        {
          id: 'skill-1',
          name: 'n'.repeat(SKILL_DISCOVERY_LIMITS.nameLength + 1),
          description: 'd'.repeat(SKILL_DISCOVERY_LIMITS.descriptionLength + 1),
          providers: ['claude'],
          sourceKind: 'home',
          sourceLabel: 'Claude',
          rootPath: '/home/remote/.claude/skills',
          directoryPath: '/home/remote/.claude/skills/docs',
          skillFilePath: '/home/remote/.claude/skills/docs/SKILL.md',
          installed: true,
          updatedAt: 1
        }
      ],
      sources: [],
      scannedAt: 1
    })

    expect(parsed.skills[0].name).toHaveLength(SKILL_DISCOVERY_LIMITS.nameLength)
    expect(parsed.skills[0].description).toHaveLength(SKILL_DISCOVERY_LIMITS.descriptionLength)
  })

  it('rejects a remote path too long to name a real file', () => {
    expect(() =>
      parseSkillDiscoveryResult({
        skills: [],
        sources: [
          {
            id: 'source-1',
            label: 'Claude',
            path: `/${'a'.repeat(SKILL_DISCOVERY_LIMITS.pathLength)}`,
            sourceKind: 'home',
            providers: ['claude'],
            owner: null,
            exists: true
          }
        ],
        scannedAt: 1
      })
    ).toThrow()
  })
})
