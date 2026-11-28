import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acpPickedSkillBlocks,
  pickedSkillContentBlock,
  skillMarkdownBody
} from './acp-picked-skill-content'

const skill = { name: 'hello-test', path: '/tmp/skills/hello-test/SKILL.md' }

describe('pickedSkillContentBlock', () => {
  it('wraps the body the way OpenCode expands a picked skill', () => {
    const block = pickedSkillContentBlock(skill, 'Always reply with BANANA.')
    expect(block.type).toBe('text')
    expect(block.annotations).toEqual({ audience: ['assistant'] })
    if (block.type !== 'text') {
      throw new Error('expected a text block')
    }
    expect(block.text).toContain('<skill_content name="hello-test">')
    expect(block.text).toContain('# Skill: hello-test')
    expect(block.text).toContain('Always reply with BANANA.')
    expect(block.text).toContain('Base directory for this skill: /tmp/skills/hello-test')
    expect(block.text).toContain('</skill_content>')
  })
})

describe('skillMarkdownBody', () => {
  it('drops the picker frontmatter but keeps the instructions', () => {
    expect(
      skillMarkdownBody('---\nname: hello-test\ndescription: test\n---\n\nAlways reply BANANA.\n')
    ).toBe('Always reply BANANA.')
  })

  it('drops a CRLF frontmatter header', () => {
    expect(
      skillMarkdownBody('---\r\nname: hello-test\r\n---\r\n\r\nAlways reply BANANA.\r\n')
    ).toBe('Always reply BANANA.')
  })

  it('keeps instructions after an empty frontmatter header', () => {
    expect(skillMarkdownBody('---\n---\nRequired instruction.\n\n---\nMore text.')).toBe(
      'Required instruction.\n\n---\nMore text.'
    )
  })

  it('does not treat a long space run as a frontmatter delimiter', () => {
    const longLine = 'x'.padStart(500_001)
    expect(skillMarkdownBody(`---\n${longLine}\n---\nAlways reply BANANA.`)).toBe(
      'Always reply BANANA.'
    )
  })
})

describe('acpPickedSkillBlocks', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-skill-content-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reads a picked SKILL.md and skips files that are not one', async () => {
    const skillDirectory = join(directory, 'hello-test')
    mkdirSync(skillDirectory)
    const path = join(skillDirectory, 'SKILL.md')
    writeFileSync(path, '---\nname: hello-test\n---\n\nAlways reply BANANA.\n')
    const other = join(directory, 'notes.md')
    writeFileSync(other, 'not a skill')

    const blocks = await acpPickedSkillBlocks([
      { name: 'hello-test', path },
      { name: 'notes', path: other },
      { name: 'missing', path: join(directory, 'missing', 'SKILL.md') }
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    if (blocks[0]?.type === 'text') {
      expect(blocks[0].text).toContain('Always reply BANANA.')
      expect(blocks[0].text).not.toContain('description: test')
    }
  })
})
