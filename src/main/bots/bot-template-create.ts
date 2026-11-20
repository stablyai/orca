// Create from a built-in template: the bot is made from the owner's reviewed seed (SOUL.md), then gets the
// template's package from this host's own catalog: the skills the owner kept, schedules turned off, and
// a setup note offering its event automations and connectors in its first chat.
import type { Bot, BotAgent } from '../../shared/bot-types'
import { skillsFolderFor } from '../../shared/bots/bot-package'
import { botTemplate, type BotTemplate } from '../../shared/bots/bot-templates'
import type { BotCreateParams } from '../../shared/rpc-contract/bots-params'
import type { BotController, BotOrigin } from './bot-controller'
import {
  applyBotPackage,
  type BotPackageApply,
  type BotPackageApplyDeps
} from './bot-package-apply'
import { BOT_TEMPLATE_SKILL_TEXT } from './bot-template-skill-text'

export type BotTemplateCreateParams = BotCreateParams & {
  fromTemplate: NonNullable<BotCreateParams['fromTemplate']>
}

export type BotTemplateCreateDeps = BotPackageApplyDeps & {
  bots: Pick<BotController, 'create' | 'delete'>
}

export function templatePackage(
  template: BotTemplate,
  agent: BotAgent,
  keptSkills: readonly string[]
): BotPackageApply {
  const kept = new Set(keptSkills)
  return {
    files: template.skills
      .filter((skill) => kept.has(skill))
      .map((skill) => ({
        to: `${skillsFolderFor(agent)}/${skill}/SKILL.md`,
        text: BOT_TEMPLATE_SKILL_TEXT[skill]
      })),
    tools: [],
    schedules: template.schedules.map((schedule) => ({
      name: `${template.name}: ${schedule.what}`,
      prompt: schedule.prompt,
      rrule: schedule.rrule
    })),
    setup: {
      template: template.name,
      firstSteps: template.firstChat,
      connectors: [...template.connectors],
      toolsToSignIn: [],
      schedulesOff: template.schedules.map((schedule) => `${template.name}: ${schedule.what}`),
      eventsSuggested: template.events.map(({ name, source, event, prompt }) => ({
        name,
        source,
        event,
        prompt
      })),
      ...(template.needsSetup ? { sharerNote: template.needsSetup } : {})
    }
  }
}

/** How a template makes a bot: its create params and origin, then its package once the bot exists. A
 *  template this host doesn't have (a newer client's catalog) makes the bot from its seed alone. */
export function botTemplateCreation(
  deps: BotPackageApplyDeps,
  input: BotTemplateCreateParams
): { params: BotCreateParams; origin?: BotOrigin; finish: (bot: Bot) => Promise<Bot> } {
  const { fromTemplate, ...params } = input
  const template = botTemplate(fromTemplate.id)
  if (!template) {
    return { params, finish: async (bot) => bot }
  }
  const agent = params.agent ?? 'claude'
  return {
    params: { ...params, agent },
    origin: { templateId: template.id },
    finish: (bot) =>
      applyBotPackage(deps, bot, templatePackage(template, agent, fromTemplate.skills))
  }
}

export async function createBotFromTemplate(
  deps: BotTemplateCreateDeps,
  input: BotTemplateCreateParams
): Promise<Bot> {
  const made = botTemplateCreation(deps, input)
  return made.finish(await deps.bots.create(made.params, made.origin))
}
