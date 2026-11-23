// Where the stand-in's connector actions land: places a bot names, resolved as Orca Cloud resolves
// them (a ref, a channel's id or link, a whole name or key), with the shared Linear world's issues
// and teams first.
import type { EvalHostState } from './bot-automation-eval-host'
import { linearMatches } from './bot-automation-eval-linear'
import { SLACK_PLACES, slackChannelAt, slackWorkspaceNamed } from './bot-automation-eval-slack'
import { botLinearWorkspaces } from '../../shared/bot-types'

/** Whether the bot has Linear connected. */
export function hasLinear(state: EvalHostState): boolean {
  const bot = state.bots[0]
  return bot !== undefined && botLinearWorkspaces(bot).length > 0
}

const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]+$/
// A channel as Slack writes it in text (<#C0123>, <#C0123|name>) or #C0123, as slack-action-places.ts reads it.
const SLACK_CHANNEL_MENTION = /^(?:<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>|#([CGD][A-Z0-9]+))$/
// A channel's link, as slack-action-places.ts reads it.
const SLACK_LINK =
  /^https:\/\/[\w.-]*slack\.com\/(?:archives|client\/[A-Z0-9]+)\/([CGD][A-Z0-9]+)(?:\/p(\d{7,}))?\/?(?:\?(.*))?$/i

export type PlaceView = { ref: string; label: string; exact?: true }
type Refusal = { ok: false; refusal: string; message: string }

const fold = (text: string) => text.trim().toLowerCase().replace(/^#/, '')

// A scenario's own places, then the Slack world's channels it doesn't list.
function placesOf(state: EvalHostState) {
  const places = state.places ?? []
  const listed = new Set(places.map((place) => place.ref))
  const slack = state.bots[0]?.slack ? SLACK_PLACES : []
  return [...places, ...slack.filter((place) => !listed.has(place.ref))]
}

/** What input names, those it names exactly first: a ref, a channel's id or link, a whole name or
 *  key; the rest only contain it. */
export function placeMatches(state: EvalHostState, input: string): PlaceView[] {
  const wanted = fold(input)
  if (!wanted) {
    return []
  }
  // Workspaces and Linear's issues and teams, by whole name; one name may be both sources'.
  const named = [
    ...(state.bots[0]?.slack ? slackWorkspaceNamed(input) : []),
    ...(hasLinear(state) ? linearMatches(input, state.linearRun) : [])
  ]
  if (named.length > 0) {
    return named.map((match) => ({ ...match, exact: true as const }))
  }
  const trimmed = input.trim()
  const mention = SLACK_CHANNEL_MENTION.exec(trimmed)
  const channel =
    SLACK_LINK.exec(trimmed)?.[1] ??
    mention?.[1] ??
    mention?.[2] ??
    (SLACK_CHANNEL_ID.test(trimmed) ? trimmed : null)
  const views = placesOf(state).flatMap(({ ref, label }): PlaceView[] => {
    const name = fold(label)
    const exact =
      ref === trimmed ||
      (channel !== null && ref.split(':')[2] === channel) ||
      name === wanted ||
      name.split(' ')[0] === wanted
    return exact ? [{ ref, label, exact }] : name.includes(wanted) ? [{ ref, label }] : []
  })
  const exact = views.filter((view) => view.exact)
  // A scenario that lists no places has every place it names.
  if (!state.places && exact.length === 0) {
    return [{ ref: input, label: input, exact: true }]
  }
  return [...exact, ...views.filter((view) => !view.exact)]
}

// A message in one of the Slack world's channels, by ref or link (p + its ts without the dot).
function worldMessageRef(input: string): string | null {
  const link = SLACK_LINK.exec(input.trim())
  const channel = link && SLACK_PLACES.find((place) => place.ref.endsWith(`:${link[1]}`))
  const ref =
    channel && link[2]
      ? `${channel.ref}::${link[2].slice(0, -6)}.${link[2].slice(-6)}`
      : input.trim()
  const [inChannel, ts] = ref.split('::')
  return ts !== undefined && SLACK_PLACES.some((place) => place.ref === inChannel) ? ref : null
}

/** The one place, or message in one, an action's input names, worded as Orca Cloud refuses. */
export function resolvePlace(state: EvalHostState, input: string): PlaceView | Refusal {
  const notFound: Refusal = {
    ok: false,
    refusal: 'not_found',
    message: `Nothing the bot can reach matches "${input}". Pass a ref, a link, or run \`orca slack find\`.`
  }
  if (state.places?.some((place) => input.startsWith(`${place.ref}:`))) {
    return { ref: input, label: input }
  }
  const message = worldMessageRef(input)
  if (message) {
    const inSlack = slackChannelAt(message)
    return inSlack ? { ref: message, label: inSlack.label } : notFound
  }
  const found = placeMatches(state, input)
  const exact = found.filter((view) => view.exact)
  if (exact.length === 1) {
    return exact[0]!
  }
  if (found.length === 0) {
    return notFound
  }
  return {
    ok: false,
    refusal: 'ambiguous',
    message: [
      `"${input}" names no one place exactly; pass one of these refs:`,
      ...(exact.length > 0 ? exact : found).map((place) => `${place.ref}  ${place.label}`)
    ].join('\n')
  }
}
