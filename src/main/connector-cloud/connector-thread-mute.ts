// Per-thread mute for a bot's Slack thread, decided before the agent sees the message: "mute" (or
// "be quiet", "stop responding in this thread") stops later replies reaching it until an @mention
// or "unmute". The bot's own posts (a background run's result, an automation) still go out.
import type {
  ConnectorConversation,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { SendDelivery } from './connector-deliveries'

export type ThreadMuteCommand = 'mute' | 'unmute'

const MUTE_PHRASES = [
  'mute',
  'mute this',
  'mute here',
  'mute this thread',
  'mute thread',
  'be quiet',
  'quiet',
  'shh',
  'shush',
  'stay quiet',
  'go quiet',
  'stop responding',
  'stop responding here',
  'stop responding in this thread',
  'stop replying',
  'stop replying here',
  'stop replying in this thread'
]
const UNMUTE_PHRASES = [
  'unmute',
  'unmute this',
  'unmute here',
  'unmute this thread',
  'unmute thread',
  'start responding',
  'start responding again',
  'start replying again',
  'resume responding',
  'you can respond again'
]

const COMMANDS = new Map<string, ThreadMuteCommand>([
  ...MUTE_PHRASES.map((phrase) => [phrase, 'mute'] as const),
  ...UNMUTE_PHRASES.map((phrase) => [phrase, 'unmute'] as const)
])

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}@<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The command a whole message is, after any leading mentions of the bot (`<@U…>`, `@name`) and a
 *  "please"; null for anything else, so "mute the video" or "don't mute" never mutes. */
export function threadMuteCommand(
  text: string,
  botNames: readonly string[] = []
): ThreadMuteCommand | null {
  let rest = normalized(text)
  const names = botNames.map((name) => normalized(name)).filter((name) => name.length > 0)
  // A mention's name may run past its first word: "@Orca reviewer" names the bot reviewer.
  const startsWith = (name: string) => rest === name || rest.startsWith(`${name} `)
  for (;;) {
    const slackMention = /^<@[^>]+>\s*/.exec(rest)
    const named = names.find((name) => startsWith(`@${name}`))
    if (slackMention) {
      rest = rest.slice(slackMention[0].length)
    } else if (named) {
      rest = rest.slice(named.length + 1).trimStart()
    } else if (/^@\S+(\s|$)/.test(rest)) {
      rest = rest.replace(/^@\S+\s*/, '')
      const handle = names.find(startsWith)
      rest = handle ? rest.slice(handle.length).trimStart() : rest
    } else {
      break
    }
  }
  rest = rest
    .replace(/^please /, '')
    .replace(/ please$/, '')
    .replace(/ thanks$/, '')
  return COMMANDS.get(rest) ?? null
}

/** What a send to a bot's thread does: a command is handled here and never reaches the agent; a
 *  muted thread silences any send that doesn't mention the bot; a mention unmutes and goes on. */
export type ThreadMuteStep = 'mute' | 'unmute' | 'silence' | 'unmute_and_send' | 'send'

export function threadMuteStep(
  muted: boolean,
  delivery: Pick<SendDelivery, 'text' | 'bareMention' | 'mentioned' | 'resume'>,
  botNames: readonly string[] = []
): ThreadMuteStep {
  const command = delivery.resume ? null : threadMuteCommand(delivery.text, botNames)
  if (command) {
    return command
  }
  if (!muted) {
    return 'send'
  }
  // A bare mention is a mention; Resume is pressed on the bot's own message, as deliberate as one.
  return delivery.mentioned || delivery.bareMention || delivery.resume
    ? 'unmute_and_send'
    : 'silence'
}

export const MUTED_EMOJI = ':mute:'
export const UNMUTED_EMOJI = ':loud_sound:'

export type ThreadMuteDeps = {
  /** The thread's bot and whether it is muted; null for a conversation that isn't a bot's Slack thread here. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | null
  write: (key: ConnectorConversation, muted: boolean) => void
  botNames: (botId: string) => string[]
  react: (
    botId: string,
    key: ConnectorConversation,
    messageRef: string,
    emoji: string
  ) => Promise<void>
}

/** Settles a send this step handled (accepted, no turn); null when it goes on to the agent. */
export function handleThreadMute(
  deps: ThreadMuteDeps,
  delivery: SendDelivery
): Promise<ConnectorDeliveryResult> | null {
  const key = delivery.conversation
  const thread = key.source === 'slack' ? deps.read(key) : null
  if (!thread) {
    return null
  }
  const step = threadMuteStep(thread.muted, delivery, deps.botNames(thread.botId))
  if (step === 'send') {
    return null
  }
  if (step !== 'silence') {
    deps.write(key, step === 'mute')
  }
  if (step === 'unmute_and_send') {
    return null
  }
  const ref = delivery.asker?.messageRef
  if (ref && step !== 'silence') {
    // The emoji is the only answer: a failed one leaves the thread muted (or not) all the same.
    void deps
      .react(thread.botId, key, ref, step === 'mute' ? MUTED_EMOJI : UNMUTED_EMOJI)
      .catch((error: unknown) =>
        console.warn('[connectors] could not react to a thread mute', error)
      )
  }
  return Promise.resolve({ outcome: 'accepted' })
}
