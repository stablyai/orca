import { basename, dirname, isAbsolute } from 'node:path'
import type { AgentJournalSkillRef } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import type { ContentBlock } from '../generated/acp-protocol.generated'

// A skill is instructions, not payload; keep one pathological file from crowding out the prompt.
const MAX_SKILL_CONTENT_BYTES = 512 * 1024
const MAX_SKILL_CONTENT_TOTAL_BYTES = 1024 * 1024
const SKILL_CONTENT_READ_TIMEOUT_MS = 5_000

const isFrontmatterDelimiter = (line: string | undefined): boolean =>
  line !== undefined && /^---[ \t\r]*$/.test(line)

/** The picker reads frontmatter for its label; the instructions the model needs start after it. */
export function skillMarkdownBody(markdown: string): string {
  // Line scanning, not a regex: an empty header and a body full of newlines must both stay linear.
  const lines = markdown.replace(/^\uFEFF/, '').split('\n')
  if (!isFrontmatterDelimiter(lines[0])) {
    return lines.join('\n').trim()
  }
  const end = lines.findIndex((line, index) => index > 0 && isFrontmatterDelimiter(line))
  return (end === -1 ? lines : lines.slice(end + 1)).join('\n').trim()
}

/** The shape OpenCode's TUI expands a picked skill into; assistant audience becomes a synthetic message. */
export function pickedSkillContentBlock(skill: AgentJournalSkillRef, body: string): ContentBlock {
  return {
    type: 'text',
    text: [
      `<skill_content name="${skill.name}">`,
      `# Skill: ${skill.name}`,
      '',
      body,
      '',
      `Base directory for this skill: ${dirname(skill.path)}`,
      'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
      '</skill_content>'
    ].join('\n'),
    annotations: { audience: ['assistant'] }
  }
}

/** A picked skill the host cannot read stays a plain token instead of failing the message. */
export async function acpPickedSkillBlocks(
  skills: readonly AgentJournalSkillRef[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  if (skills.length === 0) {
    return blocks
  }
  const signal = AbortSignal.timeout(SKILL_CONTENT_READ_TIMEOUT_MS)
  // stat/open cannot observe the signal, so race the whole read: an unresponsive mount must not hold the prompt.
  const deadline = new Promise<null>((resolve) => {
    if (signal.aborted) {
      resolve(null)
      return
    }
    signal.addEventListener('abort', () => resolve(null), { once: true })
  })
  let remaining = MAX_SKILL_CONTENT_TOTAL_BYTES
  for (const skill of skills) {
    if (remaining <= 0 || signal.aborted) {
      break
    }
    // The picker offers SKILL.md files; anything else is not the instructions it described.
    if (!isAbsolute(skill.path) || basename(skill.path) !== 'SKILL.md') {
      continue
    }
    try {
      const pending = readNodeFileWithinLimit(
        skill.path,
        Math.min(MAX_SKILL_CONTENT_BYTES, remaining),
        { regularFileOnly: true, signal }
      )
      // The read may settle after the deadline; handle its rejection and let its handle close.
      pending.catch(() => {})
      const read = await Promise.race([pending, deadline])
      if (!read) {
        break
      }
      const body = skillMarkdownBody(read.buffer.toString('utf8'))
      if (body) {
        blocks.push(pickedSkillContentBlock(skill, body))
        remaining -= read.buffer.byteLength
      }
    } catch {
      // A timed-out read ends the loop; a missing or unreadable file must not block the message.
      if (signal.aborted) {
        break
      }
    }
  }
  return blocks
}
