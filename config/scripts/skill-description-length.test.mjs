import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// The Agent Skills spec caps the YAML frontmatter `description` at 1–1,024
// characters (after YAML folding). Spec-compliant clients and installers (e.g.
// SkillStar) reject a skill whose description exceeds that — discovered via
// issue #17935, where `orchestration` was 1,038 chars and therefore not
// installable while the other seven skills were. This guard keeps every
// bundled skill within the portable limit so a future edit can't re-break
// installability (#17935).
const projectDir = resolve(import.meta.dirname, '../..')
const skillsRoot = join(projectDir, 'skills')
const MAX_DESCRIPTION_LENGTH = 1024

function extractDescription(skillText) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(skillText)?.[1] ?? ''
  return parse(frontmatter)?.description ?? ''
}

describe('bundled skill metadata stays within the Agent Skills spec limit', () => {
  it('every bundled SKILL.md description is ≤ 1024 characters', () => {
    const entries = readdirSync(skillsRoot, { withFileTypes: true }).filter(
      (e) => e.isDirectory(),
    )
    expect(entries.length).toBeGreaterThan(0)

    const over = []
    for (const entry of entries) {
      const skillPath = join(skillsRoot, entry.name, 'SKILL.md')
      const skill = readFileSync(skillPath, 'utf8')
      const desc = extractDescription(skill)
      if (desc.length > MAX_DESCRIPTION_LENGTH) {
        over.push(
          `${entry.name}: description is ${desc.length} chars (limit ${MAX_DESCRIPTION_LENGTH})`,
        )
      }
    }

    expect(over).toEqual([])
  })
})
