import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const skillsDir = resolve(import.meta.dirname, '../../skills')
// Why: the Agent Skills spec caps `description` at 1024 chars and conforming installers
// reject the whole skill (#17935); the frontmatter is what the installer parses, so check it.
const MAX_DESCRIPTION_LENGTH = 1024

function readDescription(skillName) {
  const skillMarkdown = readFileSync(join(skillsDir, skillName, 'SKILL.md'), 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(skillMarkdown)?.[1]

  expect(frontmatter, `${skillName}: missing frontmatter`).toBeDefined()

  return parse(frontmatter ?? '').description
}

describe('bundled skill descriptions', () => {
  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  it('discovers the bundled skills', () => {
    expect(skillNames).toContain('orchestration')
  })

  it.each(skillNames)('%s keeps description within the Agent Skills spec limit', (name) => {
    const description = readDescription(name)

    expect(typeof description, `${name}: description must be a string`).toBe('string')
    expect(description.trim().length, `${name}: description is empty`).toBeGreaterThan(0)
    expect(
      description.length,
      `${name}: description is ${description.length} chars`
    ).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })
})
