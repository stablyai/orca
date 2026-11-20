// How `orca slack` prints each verb's answer.
import { inlineUntrusted, untrustedContent } from '../../shared/quoted-text-fence'
import type { SlackVerb } from './slack-action-args'

type RefView = { ref: string; label: string }
type MessageFile = { id: string; name: string; type?: string; size?: number }

export type ActionResult = {
  target?: RefView
  // A post's: why it can't wake an Orca bot it mentions.
  notices?: string[]
  // A post Orca Cloud took and sends shortly; target is then its place.
  queued?: true
  // A post that has gone: its web link.
  url?: string
  // What the read left out, in words.
  note?: string
  messages?: (RefView & {
    author: string
    // Posted by an app (a Slack bot_id), whatever user id Slack gave it: never read as a person's.
    app?: true
    text: string
    at: number
    url?: string
    files?: MessageFile[]
  })[]
  // A file read with --download: where to stream it from, with the ticket that opens it.
  download?: MessageFile & { data?: string; url?: string; ticket?: string }
  // attach with stage: where the file's bytes go, straight to the source.
  upload?: { url: string }
  before?: string
  // find: a message search's matches carry what each says around the searched words.
  matches?: (RefView & { text?: string })[]
  access?: {
    member: boolean
    canRead: boolean
    canPost: boolean
    howToJoin?: string
    joined?: true
  }
}
const line = (view: RefView) => `${view.ref}  ${view.label}`
// A person find lists also shows how a post mentions them and that posting to the ref DMs them.
const PERSON_REF = /^slack:[^:]+:user:([UW][A-Z0-9]+)$/
const findLine = (view: RefView) => {
  const id = PERSON_REF.exec(view.ref)?.[1]
  return id ? `${line(view)} · mention with <@${id}>, post to it to DM them` : line(view)
}

const authorName = (name: string) => inlineUntrusted(name, 64) || 'someone'

export function formatActionResult(verb: SlackVerb | 'attach', result: ActionResult): string {
  switch (verb) {
    case 'find':
      return [
        // Other people's words: quoted under Orca's line, as read shows them.
        ...(result.matches?.length
          ? result.matches.map((match) =>
              match.text === undefined
                ? findLine(match)
                : [findLine(match), untrustedContent('what it says', match.text)].join('\n')
            )
          : ['No matches.']),
        ...(result.note ? [result.note] : [])
      ].join('\n')
    case 'read': {
      // Other people's words: quoted under Orca's line, so they read as content, never as orders.
      const messages = (result.messages ?? []).map((message) =>
        [
          message.url ? `${message.ref}  ${message.url}` : message.ref,
          untrustedContent(
            `${message.app ? `the app ${authorName(message.author)} posted` : `${authorName(message.author)} wrote`}, ${new Date(message.at).toISOString()}`,
            message.text
          ),
          ...(message.files ?? []).map(
            (file) =>
              `[Orca: file ${file.id}: ${authorName(file.name)}${file.type ? `, ${file.type}` : ''}${file.size === undefined ? '' : `, ${Math.ceil(file.size / 1024)} KB`}; --download ${file.id} saves it]`
          )
        ].join('\n')
      )
      return [
        ...(result.target ? [line(result.target)] : []),
        ...(messages.length > 0 ? messages : ['No messages.']),
        ...(result.before ? [`Older: --before ${result.before}`] : []),
        ...(result.note ? [result.note] : [])
      ].join('\n')
    }
    case 'check': {
      const access = result.access
      return [
        ...(result.target ? [line(result.target)] : []),
        ...(access
          ? [
              `${access.joined ? 'Joined. ' : ''}In it: ${access.member ? 'yes' : 'no'}; can read: ${access.canRead ? 'yes' : 'no'}; can post: ${access.canPost ? 'yes' : 'no'}`,
              ...(access.howToJoin ? [access.howToJoin] : [])
            ]
          : [])
      ].join('\n')
    }
    case 'post':
    case 'attach':
      if (!result.target) {
        return 'Posted.'
      }
      return [
        `${result.queued ? 'Queued' : 'Posted'}: ${line(result.target)}`,
        ...(result.url ? [`Link: ${result.url}`] : []),
        ...(result.note ? [result.note] : []),
        ...(result.notices ?? [])
      ].join('\n')
    case 'react':
      return result.target ? line(result.target) : 'Done.'
    case 'edit':
      return result.target ? `Edited: ${result.target.ref}` : 'Edited.'
    case 'delete':
      return result.target ? `Deleted: ${result.target.ref}` : 'Deleted.'
  }
}

/** Where a download went; its name is someone else's, so it can't pose as Orca's line. */
export const formatSaved = (file: MessageFile, savedTo: string) =>
  `Saved ${authorName(file.name)} to ${savedTo}`
