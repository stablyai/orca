import { RuntimeClientError } from '../runtime-client'

export type BundledSkillGuideReference = {
  name: string
  markdown: string
}

export type BundledSkillGuide = {
  name: string
  description: string
  markdown: string
  fullMarkdown: string
  aliases: readonly string[]
  references: readonly BundledSkillGuideReference[]
}

function canonicalGuides(guides: readonly BundledSkillGuide[]): BundledSkillGuide[] {
  return [...guides].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
}

/**
 * Load the embedded guide table in canonical order. Deferred because the table is
 * large and unrelated CLI commands must not pay its module-load cost at startup.
 */
export async function loadCanonicalGuides(): Promise<BundledSkillGuide[]> {
  const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
  return canonicalGuides(BUNDLED_SKILL_GUIDES)
}

export function requireTopic(
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
