import { open, stat } from 'node:fs/promises'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'

const MAX_MARKDOWN_BYTES = 256 * 1024

export type MarkdownSummary = {
  name: string | null
  description: string | null
  updatedAt: number | null
}

/** Frontmatter summary of a markdown file, bounded to the head of the file so a
 *  huge document costs one page read. Shared by skill and slash-command scans. */
export async function readMarkdownSummary(filePath: string): Promise<MarkdownSummary | null> {
  try {
    const fileStat = await stat(filePath)
    const file = await open(filePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_MARKDOWN_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    return {
      ...summarizeSkillMarkdown(content),
      updatedAt: fileStat.mtimeMs
    }
  } catch {
    return null
  }
}
