import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The skill catalog caps a description at 500 characters; longer ones are truncated by
// consumers that read the frontmatter. These two guides were folded past the cap, so pin
// them: a regression here silently truncates the trigger text every consumer sees.
const MAX_DESCRIPTION_LENGTH = 500
const CAPPED_SKILLS = ['orca-cli', 'orca-computer-use'] as const
const REPO_ROOT = join(import.meta.dirname, '../../../..')

function frontmatterDescription(markdown: string, sourcePath: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  if (!match) throw new Error(`Missing YAML frontmatter: ${sourcePath}`)
  const lines = match[1].split('\n')
  const start = lines.findIndex((line) => line.startsWith('description:'))
  if (start === -1) throw new Error(`Missing description: ${sourcePath}`)
  const inline = lines[start].slice('description:'.length).trim()
  if (inline !== '>-' && inline !== '>') {
    return inline.replace(/^['"]/, '').replace(/['"]$/, '')
  }
  const folded: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    folded.push(line.trim())
  }
  return folded.join(' ').replace(/\s+/g, ' ').trim()
}

async function descriptionAt(relativePath: string): Promise<string> {
  const sourcePath = join(REPO_ROOT, relativePath)
  return frontmatterDescription(await readFile(sourcePath, 'utf8'), sourcePath)
}

describe('bundled skill descriptions', () => {
  it.each(CAPPED_SKILLS)('keeps the %s description within the 500-character cap', async (name) => {
    const description = await descriptionAt(`skill-guides/${name}.md`)
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })

  it.each(CAPPED_SKILLS)('keeps the generated %s projection in sync with its guide', async (name) => {
    const guide = await descriptionAt(`skill-guides/${name}.md`)
    const projection = await descriptionAt(`skills/${name}/SKILL.md`)
    expect(projection).toBe(guide)
  })
})
