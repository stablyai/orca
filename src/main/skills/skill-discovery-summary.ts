import { open, stat } from 'node:fs/promises'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import { bundledSkillDiscoveryName } from './bundled-skill-discovery-name'

const MAX_MARKDOWN_BYTES = 256 * 1024

export async function readSkillSummary(skillFilePath: string): Promise<{
  name: string | null
  bundledName?: string
  description: string | null
  updatedAt: number | null
} | null> {
  try {
    const fileStat = await stat(skillFilePath)
    const file = await open(skillFilePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_MARKDOWN_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    const summary = summarizeSkillMarkdown(content)
    const bundledName = bundledSkillDiscoveryName(summary.name, content)
    return {
      ...summary,
      ...(bundledName ? { bundledName } : {}),
      updatedAt: fileStat.mtimeMs
    }
  } catch {
    return null
  }
}
