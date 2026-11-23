// The stand-in's Slack search: as the asker through the connector (searchSlack), as the cloud's
// does, and as the owner through their own agent-slack (searchSlackAsOwner). Held to the cloud's
// recorded answers by bot-automation-eval-slack.test.ts.
import WORLD from './bot-automation-eval-slack-world.json'
import {
  authorOf,
  labelOf,
  MAX_LABEL,
  messageRef,
  OWNER_SLACK_ID,
  slackPeople
} from './bot-automation-eval-slack'

// A search's limits, and how much of a message a hit's label carries (slack-action-search.ts).
const SEARCH_LIMIT = 20
const SEARCH_TEXT = 120
const HIT_TEXT = 1500

// A message as the cloud's find shows it (slackHitText): whole when short, else the stretch around
// the first searched word it holds (or its start), marked where cut.
function hitText(text: string, query: string): string {
  if (text.length <= HIT_TEXT) {
    return text
  }
  const lower = text.toLowerCase()
  const found = (query.match(/"[^"]*"?|[^\s"]+/g) ?? [])
    .filter((term) => term.startsWith('"') || !(term.startsWith('-') || /^[a-z]+:/i.test(term)))
    // A prefix search (export*) finds its stem.
    .map((term) => term.replace(/["*]/g, '').trim().toLowerCase())
    .flatMap((word) => (word && lower.includes(word) ? [lower.indexOf(word)] : []))
  const start =
    found.length === 0
      ? 0
      : Math.max(0, Math.min(Math.min(...found) - HIT_TEXT / 3, text.length - HIT_TEXT))
  const end = start + HIT_TEXT
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

// Whether a message holds a search term, as Slack reads one: from:<@U…> (from:me, the searcher) and
// in:<#C…> by author and channel (only bracketed ids filter), -term as its opposite, and any other
// word or "quoted phrase" in its text or its author's name.
function holds(message: (typeof WORLD.messages)[number], term: string, searcher: string): boolean {
  if (term.length > 1 && term.startsWith('-')) {
    return !holds(message, term.slice(1), searcher)
  }
  const [, author] = /^from:<@([UW][A-Z0-9]+)>$/.exec(term) ?? []
  const [, channel] = /^in:<#(C[A-Z0-9]+)(?:\|[^>]*)?>$/.exec(term) ?? []
  return author || term === 'from:me'
    ? message.author === (author ?? searcher)
    : channel
      ? message.channel === channel
      : `${authorOf(message.author)} ${message.text}`
          .toLowerCase()
          .includes(term.replace(/"/g, '').toLowerCase())
}

// from:@name and in:#name (and -exclusions) as the cloud rewrites them (slack-action-search.ts).
const MODIFIER = /^(-?)(from|in):([@#]?)([^<\s].*)$/i
const isId = (value: string, shape: RegExp) => shape.test(value) && /\d/.test(value)

/** The query as the cloud sends it to Slack: a modifier naming exactly one person or channel by
 *  name becomes its id; anything else, from:me and "quoted phrases" stay as typed. */
export function slackSearchQuery(text: string): string {
  const onlyId = (ids: string[]) => (ids.length === 1 ? ids[0]! : null)
  return (text.match(/"[^"]*"?|\s+|[^\s"]+/g) ?? [])
    .map((word) => {
      const [, not, kind, sigil, name] = MODIFIER.exec(word) ?? []
      if (!kind || !name || (!sigil && /^from$/i.test(kind) && /^me$/i.test(name))) {
        return word
      }
      const person = /^from$/i.test(kind) || sigil === '@'
      const found = person
        ? onlyId(slackPeople(name).flatMap((each) => (each.exact ? [each.id] : [])))
        : onlyId(
            WORLD.channels.flatMap((each) =>
              each.name === name.toLowerCase() && !('private' in each && each.private)
                ? [each.id]
                : []
            )
          )
      const shape = person ? /^[UW][A-Z0-9]+$/ : /^[CGD][A-Z0-9]+$/
      const id = found ?? (!sigil && isId(name, shape) ? name : null)
      return id ? `${not}${kind.toLowerCase()}:<${person ? '@' : '#'}${id}>` : word
    })
    .join('')
}

/** A conversation a search is asked in: its channel, and its thread (the channel, for a DM). */
export type SlackConversation = { channel: string; thread: string }

const WORLD_CONVERSATION = { channel: WORLD.conversationChannel, thread: WORLD.conversationThread }

// Whether Slack says a conversation's channel is public: a world channel by its kind, a DM never;
// null for one it can't classify.
function isPublic(channelId: string): boolean | null {
  const channel = WORLD.channels.find((each) => each.id === channelId)
  return channel
    ? !('private' in channel && channel.private)
    : channelId.startsWith('D')
      ? false
      : null
}

// What the note says of the conversation itself: searched with the public channels, or read instead.
function conversationNote({ channel, thread }: SlackConversation): string {
  const ref = `slack:${WORLD.teamId}:${channel}${thread === channel ? '' : `:${thread}`}`
  const kind = isPublic(channel)
  return kind === true
    ? 'Public channels and this conversation only.'
    : kind === false
      ? `Public channels only. This conversation is private and isn't searched; read it with \`orca slack read ${ref}\`.`
      : `Public channels only. Read this conversation with \`orca slack read ${ref}\`.`
}

/** find --search's answer as the asker: the world's messages holding every term of the query as
 *  the cloud rewrites it, shown only from public channels the asker is in; one whose members are
 *  unknown is left out with a note, and a rewritten query is shown, as the cloud's are. The note
 *  says whether the conversation it's asked in was searched. */
export function searchSlack(
  asker: string,
  text: string,
  own: SlackConversation = WORLD_CONVERSATION
) {
  const query = slackSearchQuery(text)
  const terms = query.match(/-?"[^"]*"?|[^\s"]+/g) ?? []
  const hits = WORLD.messages
    .filter((message) => terms.every((term) => holds(message, term, asker)))
    .slice(0, SEARCH_LIMIT)
    .map((message) => ({
      message,
      channel: WORLD.channels.find((channel) => channel.id === message.channel)
    }))
  const isOwn = (channel: (typeof hits)[number]['channel']) => channel?.id === own.channel
  // Only a public channel's hits, the conversation's own included; never a DM's or a private one's.
  const allowed = hits.filter(({ channel }) => channel && isPublic(channel.id) === true)
  const shown = allowed.filter(({ channel }) => channel?.members?.includes(asker))
  const unknown = allowed.some(({ channel }) => channel && channel.members === null)
  return {
    matches: shown.map(({ message, channel }) => ({
      ref: messageRef(message),
      label:
        `${channel ? `#${channel.name}` : message.channel} ${isOwn(channel) ? '(this channel)' : '(public)'} · ${labelOf(message, SEARCH_TEXT)}`.slice(
          0,
          MAX_LABEL
        ),
      ...(message.text ? { text: hitText(message.text, query) } : {})
    })),
    note: [
      ...(query === text ? [] : [`Searched for: ${query}\n`]),
      conversationNote(own),
      ...(unknown
        ? [
            " Some matches are left out: Slack couldn't say whether the person is in their channels."
          ]
        : [])
    ].join('')
  }
}

/** The owner's own Slack search (their agent-slack on the host), newest first in its JSON's shape:
 *  every public channel, and each private channel and DM they are in, by an author and any of some
 *  channels. It errs toward showing more than the real tool, never less: nothing limits it to a
 *  thread. */
export function searchSlackAsOwner(
  query: string,
  filter: { user?: string; channels?: string[] } = {}
) {
  // Their own tool names their private channels too, which the cloud's rewrite never does; date
  // terms are dropped, so it shows more rather than less.
  const named = `${query}${filter.user ? ` from:${filter.user}` : ''}`
    .replace(/\b(?:after|before|on|during):\S+/gi, '')
    .replace(/\bin:#?([a-z0-9_-]+)/gi, (term, name: string) => {
      const channel = WORLD.channels.find((each) => each.name === name.toLowerCase())
      return channel?.members?.includes(OWNER_SLACK_ID) ? `in:<#${channel.id}>` : term
    })
  const terms = slackSearchQuery(named).match(/-?"[^"]*"?|[^\s"]+/g) ?? []
  const wanted = filter.channels?.map((name) => name.replace(/^#/, '').toLowerCase())
  return WORLD.messages
    .flatMap((message) => {
      const channel = WORLD.channels.find((each) => each.id === message.channel)
      const hidden =
        channel &&
        'private' in channel &&
        channel.private &&
        !channel.members?.includes(OWNER_SLACK_ID)
      const named =
        !wanted ||
        (channel && (wanted.includes(channel.name) || wanted.includes(channel.id.toLowerCase())))
      return hidden || !named || !terms.every((term) => holds(message, term, OWNER_SLACK_ID))
        ? []
        : [
            // As the real tool prints a hit: ids only, so nothing marks a channel or DM private.
            {
              channel_id: message.channel,
              ts: message.ts,
              author: { user_id: message.author },
              content: message.text
            }
          ]
    })
    .sort((a, b) => Number(b.ts) - Number(a.ts))
}
