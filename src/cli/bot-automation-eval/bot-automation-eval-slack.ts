// The stand-in's Slack people and messages: one world every scenario shares
// (bot-automation-eval-slack-world.json). Each member is as Orca Cloud read their profile, a lookup
// finds whom its own does, and a read shows a world channel (its search is
// bot-automation-eval-slack-search.ts); the connector service records them from its real code, and bot-automation-eval-slack.test.ts holds these files to the recordings.
import { z } from 'zod'
import ANSWERS from './bot-automation-eval-slack-answers.json'
import WORLD from './bot-automation-eval-slack-world.json'

const Person = z.object({
  id: z.string(),
  name: z.string(),
  realName: z.string().optional(),
  handle: z.string().optional(),
  title: z.string().optional(),
  email: z.string().optional(),
  timezone: z.string().optional()
})
type Person = z.infer<typeof Person>

// As Slack's member list reads, by name (slack-bot-members.ts).
const MEMBERS = Object.values(z.record(z.string(), Person).parse(ANSWERS.persons)).sort((a, b) =>
  a.name.localeCompare(b.name)
)
const MAX_RESULTS = 50
// A find label's limits (slack-actions.ts).
const MAX_FACT = 60
export const MAX_LABEL = 200

// Who find looks up: @name, user:<id>, or a mention as Slack writes it (slack-actions.ts); or the
// ref a lookup answered with.
const PERSON_INPUT = /^(?:@(\S.{0,79})|user:([UW][A-Z0-9]+)|<@([UW][A-Z0-9]+)(?:\|[^>]*)?>)$/
const PERSON_REF = new RegExp(`^slack:${WORLD.teamId}:user:([UW][A-Z0-9]+)$`)

/** Who every eval message is from (bot-orchestration-eval-connector-fixtures.ts asked()). */
export const OWNER_SLACK_ID = 'U0OWNER'

const namesOf = (person: Person) => [person.name, person.realName, person.handle]

/** Members whose names hold the name, whole matches (exact) first, as the cloud's lookup ranks them. */
export function slackPeople(name: string): (Person & { exact?: true })[] {
  const needle = name.trim().toLowerCase()
  const rank = (person: Person) => {
    const names = namesOf(person).map((each) => each?.toLowerCase())
    return names.includes(needle) ? 0 : names.some((each) => each?.startsWith(needle)) ? 1 : 2
  }
  return MEMBERS.filter(
    (person) => needle && namesOf(person).join('\n').toLowerCase().includes(needle)
  )
    .map((person) => ({ person, rank: rank(person) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_RESULTS)
    .map(({ person, rank }) => (rank === 0 ? { ...person, exact: true as const } : person))
}

/** find's answer for a person, as the cloud labels each; null for input that names no person. */
export function findSlackPerson(
  input: string
): { ref: string; label: string; exact?: true }[] | null {
  const trimmed = input.trim()
  const asked = PERSON_INPUT.exec(trimmed)
  const byRef = PERSON_REF.exec(trimmed)?.[1]
  if (!asked && !byRef) {
    return null
  }
  const [, name, id = asked?.[3] ?? byRef] = asked ?? []
  const found = name
    ? slackPeople(name)
    : MEMBERS.filter((person) => person.id === id).map((person) => ({
        ...person,
        exact: true as const
      }))
  return found.map((person) => {
    const names = [
      person.name,
      person.realName && `(${person.realName})`,
      person.handle && `@${person.handle}`
    ]
    return {
      ref: `slack:${WORLD.teamId}:user:${person.id}`,
      label: [names.filter(Boolean).join(' '), person.title, person.email, person.timezone]
        .filter((fact): fact is string => Boolean(fact))
        .map((fact) => fact.slice(0, MAX_FACT))
        .join(' · ')
        .slice(0, MAX_LABEL),
      ...(person.exact ? { exact: person.exact } : {})
    }
  })
}

// How much of a message a read's label carries (slack-actions.ts).
const READ_TEXT = 80

export const authorOf = (id: string) => MEMBERS.find((person) => person.id === id)?.name ?? id
export const messageRef = (message: (typeof WORLD.messages)[number]) =>
  `slack:${WORLD.teamId}:${message.channel}::${message.ts}`
export const labelOf = (message: (typeof WORLD.messages)[number], length: number) =>
  `${authorOf(message.author)}: ${message.text.replace(/\s+/g, ' ').slice(0, length)}`

/** The workspace, as `orca bot connectors` lists it. */
export const SLACK_WORKSPACE = z
  .array(z.object({ ref: z.string(), label: z.string() }))
  .parse(ANSWERS.workspaces)[0]!

/** The workspace a name finds, as the cloud's resolve does: by its name, its address (its id here,
 *  having no URL) or its places label, in any case; never from a #channel or a link. */
export function slackWorkspaceNamed(input: string): { ref: string; label: string; exact: true }[] {
  const wanted = input.trim().toLowerCase()
  const [, name, address] = /^(.*) \((.*)\)$/.exec(SLACK_WORKSPACE.label) ?? []
  return !wanted.startsWith('#') &&
    !wanted.includes('://') &&
    [name, address, SLACK_WORKSPACE.label].some((each) => each?.toLowerCase() === wanted)
    ? [{ ...SLACK_WORKSPACE, exact: true }]
    : []
}

/** The world's channels, as places a bot reaches. */
export const SLACK_PLACES = WORLD.channels.map((channel) => ({
  ref: `slack:${WORLD.teamId}:${channel.id}`,
  label: `#${channel.name}`
}))

/** A world channel, or a message in one, as a read shows it (slack-actions.ts): the bot is in every
 *  world channel, and a message in no thread reads as itself. Null for any other ref. */
export function slackChannelAt(ref: string) {
  const [channelRef, ts] = ref.split('::')
  const channel = WORLD.channels.find((entry) => channelRef === `slack:${WORLD.teamId}:${entry.id}`)
  const messages = WORLD.messages.filter(
    (message) => message.channel === channel?.id && (ts === undefined || message.ts === ts)
  )
  return channel && (ts === undefined || messages.length > 0)
    ? {
        label: `#${channel.name}`,
        messages: messages.map((message) => ({
          ref: messageRef(message),
          label: labelOf(message, READ_TEXT),
          author: authorOf(message.author),
          text: message.text,
          at: Math.floor(Number(message.ts) * 1000)
        }))
      }
    : null
}
