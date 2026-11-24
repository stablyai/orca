import { lookAroundCommandAllowed } from '../../main/bots/bot-look-around-policy'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { writes, type TurnCheck } from './bot-orchestration-eval-grading'

const HANDOFF_REQUEST =
  /\b(?:take[ -]?over|hand[ -]?(?:off|over)|hand\b.*\bto|adopt|coordinate|manage|own(?:ership)?)\b/i

export const onlySuggests: TurnCheck = (turn) => [
  ...turn.writes
    .filter((write) => write.method !== 'bots.suggest')
    .map((write) => `look-around wrote ${write.method}`),
  ...turn.commands
    .filter(
      (argv) => !lookAroundCommandAllowed(['orca', ...argv].map((word) => `'${word}'`).join(' '))
    )
    .map((argv) => `look-around tried refused command: ${argv.join(' ')}`),
  ...(isQuietBotResult(turn.reply) ? [] : ['look-around did not finish quietly'])
]

/** A usable handoff proposal: its request names every workspace and the intended bot. */
export function suggestsHandoff(input: {
  bot: string
  include: string[]
  forbid?: string[]
  nextStep: RegExp
}): TurnCheck {
  return (turn) => {
    const suggestions = writes(turn, 'bots.suggest').filter(
      (write) =>
        write.result &&
        'suggested' in write.result &&
        HANDOFF_REQUEST.test(String(write.params.ask))
    )
    const handoff = suggestions.find(
      (entry) =>
        input.include.every((id) => String(entry.params.ask).includes(id)) &&
        String(entry.params.ask).includes(input.bot)
    )
    return [
      ...onlySuggests(turn),
      ...(handoff ? [] : ['no handoff suggestion names the bot and required workspace IDs']),
      ...(handoff &&
      !input.nextStep.test(`${String(handoff.params.why)} ${String(handoff.params.ask)}`)
        ? ['handoff suggestion leaves out the concrete next step']
        : []),
      ...(input.forbid ?? [])
        .filter((id) => suggestions.some((entry) => String(entry.params.ask).includes(id)))
        .map((id) => `suggested handing over excluded workspace ${id}`)
    ]
  }
}

export const suggestsNothing: TurnCheck = (turn) => [
  ...onlySuggests(turn),
  ...(writes(turn, 'bots.suggest').length ? ['suggested work when nothing qualified'] : [])
]

/** Declining ownership leaves unrelated suggestions available, including a review on the same PR. */
export function neverSuggestsHandoff(workspace: { id: string; name: string }): TurnCheck {
  return (turn) => [
    ...onlySuggests(turn),
    ...writes(turn, 'bots.suggest')
      .filter((entry) => {
        const text = `${String(entry.params.title)} ${String(entry.params.why)} ${String(entry.params.ask)}`
        return (
          (text.includes(workspace.id) || text.includes(workspace.name)) &&
          HANDOFF_REQUEST.test(String(entry.params.ask))
        )
      })
      .map(() => `suggested a dismissed handoff for ${workspace.name}`)
  ]
}
