import type { CommandHandler } from '../dispatch'
import { writeStdoutLine } from '../stdout-line'
import { loadCanonicalGuides } from './bundled-skill-guide-table'
import { SKILL_GUIDE_GET_HANDLER } from './skill-guide-get'

// Why lazy: the installer's module graph is large, and unrelated commands must not load it.
function skillMutationHandler(verb: 'install' | 'update'): CommandHandler {
  return async (context) => {
    const { createSkillMutationHandler } = await import('./bundled-skill-install-command.js')
    return createSkillMutationHandler(verb)(context)
  }
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills list': async ({ json }) => {
    // Why: generated registry order is not a user-facing contract, while stable
    // canonical sorting keeps agent-visible output reproducible across builds.
    const topics = (await loadCanonicalGuides()).map((guide) => ({
      name: guide.name,
      description: guide.description.replace(/\s+/g, ' ').trim()
    }))
    writeStdoutLine(
      json
        ? JSON.stringify({ topics }, null, 2)
        : topics.map((topic) => `${topic.name}: ${topic.description}`).join('\n')
    )
  },
  ...SKILL_GUIDE_GET_HANDLER,
  'skills install': skillMutationHandler('install'),
  'skills update': skillMutationHandler('update')
}
