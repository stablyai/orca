import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const skillsDir = resolve(import.meta.dirname, '../../skills')
// Check installer-parsed frontmatter: Agent Skills caps description at 1024 chars and rejects whole skill on overflow (#17935).
const MAX_DESCRIPTION_LENGTH = 1024
// Check raw text: NVIDIA/Cowork reject HTML-like description placeholders even in backticks; move placeholders to body (compound-engineering #602).
const ANGLE_BRACKET_TOKEN = /<[A-Za-z][\w.-]*>/u

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

  it.each(skillNames)('%s keeps angle-bracket placeholders out of its description', (name) => {
    const token = ANGLE_BRACKET_TOKEN.exec(readDescription(name) ?? '')

    expect(
      token?.[0],
      `${name}: rephrase or move "${token?.[0] ?? ''}" into the skill body`
    ).toBeUndefined()
  })
})
