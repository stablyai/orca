import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'

type BundledSkillGuide = {
  name: string
  description: string
  markdown: string
  fullMarkdown: string
  aliases: readonly string[]
}

function canonicalGuides(guides: readonly BundledSkillGuide[]): BundledSkillGuide[] {
  return [...guides].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
}

function requireTopic(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): BundledSkillGuide {
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const topic = flags.get('topic')
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Missing skill topic. Available topics: ${availableTopics}`
    )
  }
  // Why: installed stubs may retain an old topic forever, so aliases and canonical
  // names share one lookup table instead of being treated as transient CLI aliases.
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const guide = guideByTopic.get(topic)
  if (!guide) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown skill topic "${topic}". Available topics: ${availableTopics}`
    )
  }
  return guide
}

function writeStdout(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`)
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills list': async ({ json }) => {
    // Why: the embedded guide table is large, so unrelated CLI commands must not
    // pay its module-load and parse cost during startup.
    const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
    const guides = canonicalGuides(BUNDLED_SKILL_GUIDES)
    // Why: generated registry order is not a user-facing contract, while stable
    // canonical sorting keeps agent-visible output reproducible across builds.
    const topics = guides.map((guide) => ({
      name: guide.name,
      description: guide.description.replace(/\s+/g, ' ').trim()
    }))
    writeStdout(
      json
        ? JSON.stringify({ topics }, null, 2)
        : topics.map((topic) => `${topic.name}: ${topic.description}`).join('\n')
    )
  },
  'skills get': async ({ flags, json }) => {
    // Why: keep the large generated table off the eager handler registry path.
    const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
    const guides = canonicalGuides(BUNDLED_SKILL_GUIDES)
    const guide = requireTopic(flags, guides)
    const full = flags.has('full')
    const markdown = full ? guide.fullMarkdown : guide.markdown
    writeStdout(json ? JSON.stringify({ name: guide.name, full, markdown }, null, 2) : markdown)
  }
}
