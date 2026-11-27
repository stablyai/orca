// `orca slack find|check|read|post|react|edit|delete|attach`: a bot's Slack verbs, as its own app, through its host and Orca Cloud.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { localFile, newPostId, saveDownload, uploadArgs, uploadFile } from './slack-action-files'
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import { printResult } from '../output/command-result-output'
import { formatActionResult, formatSaved, type ActionResult } from './slack-action-format'
import { RuntimeClientError } from '../runtime/connection/types'
import { actionArgs, readMessageText, type SlackVerb } from './slack-action-args'
import { slackReadRefusal } from './slack-read-refusal'

// The host retries an unavailable cloud itself, waiting out Retry-After.
const ACT_TIMEOUT_MS = 180_000

// The host words its own refusals; this is the one it can't: no bot chat here.
const HOST_REFUSALS: Readonly<Record<string, string>> = {
  not_a_bot_session:
    "This isn't a bot's chat. `orca slack` acts as a bot: run it from a bot's chat or one of its automation runs."
}

// GitHub and Linear are the owner's, through their own tools; only Slack is the bot's.
const NOT_SLACK =
  '`orca slack` works only in Slack. On GitHub use `gh`, on Linear `orca linear`; to answer where you were woken, `orca bot reply`.'
const OTHER_SOURCE =
  /^(?:linear|github):|^[\w.-]+\/[\w.-]+#\d+$|^[A-Z][A-Z0-9]*-\d+$|^https:\/\/(?:github\.com|linear\.app)\//

export function refuseOtherSource(input: string | undefined): void {
  if (input !== undefined && OTHER_SOURCE.test(input.trim())) {
    throw new RuntimeClientError('invalid_argument', NOT_SLACK)
  }
}

const isSlackRef = (ref: string) => ref.startsWith('slack:')

const FIND_FORMS =
  'Look a channel or person up with `orca slack find <#channel, link or @name>`, or search messages with `orca slack find --search "<words>" [--workspace <name>]`.'

/** A search runs in a workspace, named by --workspace when no place is given; with neither, the host
 *  searches the workspace of the conversation the run answers. */
function refOf(
  verb: SlackVerb,
  flags: HandlerContext['flags'],
  refFlag: 'ref' | 'query'
): string | undefined {
  if (verb !== 'find') {
    return getRequiredStringFlag(flags, refFlag)
  }
  const query = flags.get(refFlag)
  const search = flags.get('search')
  // A flag with no words after it, or neither, gets both forms rather than a bare missing flag.
  if (query === true || search === true || (query === undefined && search === undefined)) {
    throw new RuntimeClientError('invalid_argument', FIND_FORMS)
  }
  if (query !== undefined) {
    return getRequiredStringFlag(flags, refFlag)
  }
  const workspace = getOptionalStringFlag(flags, 'workspace')
  flags.delete('workspace')
  return workspace
}

type ActResponse =
  | { ok: true; result: ActionResult }
  | { ok: false; refusal: string; message: string; reason?: string; scope?: string }

function sessionOf(): string {
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    throw new RuntimeClientError('not_a_bot_session', HOST_REFUSALS.not_a_bot_session)
  }
  return sessionId
}

/** One connector.act call; a refusal, the host's or the cloud's, is thrown in words a bot acts on. */
export async function callAct(
  client: HandlerContext['client'],
  params: { sessionId: string; verb: string; ref?: string; args: ConnectorActionArgs }
) {
  const answer = await client
    .call<ActResponse>('connector.act', params, { timeoutMs: ACT_TIMEOUT_MS })
    .catch((error: unknown) => {
      const refusal = error instanceof RuntimeClientError && HOST_REFUSALS[error.code]
      throw refusal && error instanceof RuntimeClientError
        ? new RuntimeClientError(error.code, refusal)
        : error
    })
  if (!answer.result.ok) {
    const { refusal, message, reason, scope } = answer.result
    const slackRead =
      params.verb === 'read' && params.ref !== undefined && !OTHER_SOURCE.test(params.ref.trim())
    if (!slackRead) {
      throw new RuntimeClientError(refusal, message)
    }
    const explained = slackReadRefusal(message, reason, scope)
    throw new RuntimeClientError(refusal, explained.message, explained.data)
  }
  return { ...answer, result: answer.result.result }
}

/** attach: the place takes a slot for the file, its bytes go from disk straight to it, then the
 *  file is posted there with --text as its comment. Nothing shows until that last step. */
const attach: CommandHandler = async ({ flags, client, json, cwd }) => {
  const sessionId = sessionOf()
  const ref = getRequiredStringFlag(flags, 'ref')
  refuseOtherSource(ref)
  const file = await localFile(cwd, getRequiredStringFlag(flags, 'file'))
  const text = await readMessageText(flags, cwd, false)
  const stageId = newPostId()
  const staged = await callAct(client, {
    sessionId,
    verb: 'attach',
    ref,
    args: { ...uploadArgs(file), postId: stageId }
  })
  if (!staged.result.upload) {
    throw new RuntimeClientError(
      'cloud_lacks_direct_files',
      "Orca Cloud didn't say where to send the file; nothing was posted. Update Orca and try again."
    )
  }
  await uploadFile(staged.result.upload.url, file)
  // Where the slot was taken: a name the cloud resolved then resolves the same now.
  const place = staged.result.target?.ref ?? ref
  const posted = await callAct(client, {
    sessionId,
    verb: 'attach',
    ref: place,
    args: { files: [stageId], ...(text ? { text } : {}), postId: newPostId() }
  })
  printResult(posted, json, (value) => formatActionResult('attach', value))
}

function act(verb: SlackVerb, refFlag: 'ref' | 'query'): CommandHandler {
  return async ({ flags, client, json, cwd }) => {
    const sessionId = sessionOf()
    const ref = refOf(verb, flags, refFlag)
    refuseOtherSource(ref)
    const answer = await callAct(client, {
      sessionId,
      verb,
      ...(ref ? { ref } : {}),
      args: await actionArgs(verb, flags, cwd)
    })
    const { result } = answer
    // A download is saved as it streams in; the link and its ticket are left out of what is printed.
    if (result.download) {
      const { data: _data, url: _url, ticket: _ticket, ...file } = result.download
      const savedTo = await saveDownload(cwd, getOptionalStringFlag(flags, 'out'), result.download)
      printResult({ ...answer, result: { ...result, download: file, savedTo } }, json, () =>
        formatSaved(file, savedTo)
      )
      return
    }
    // Finding resolves names across the bot's services; only Slack's are for this command.
    const shown = result.matches
      ? { ...result, matches: result.matches.filter((match) => isSlackRef(match.ref)) }
      : result
    printResult({ ...answer, result: shown }, json, (value) => formatActionResult(verb, value))
  }
}

export const SLACK_HANDLERS: Record<string, CommandHandler> = {
  'slack find': act('find', 'query'),
  'slack check': act('check', 'ref'),
  'slack read': act('read', 'ref'),
  'slack post': act('post', 'ref'),
  'slack react': act('react', 'ref'),
  'slack edit': act('edit', 'ref'),
  'slack delete': act('delete', 'ref'),
  'slack pin': act('pin', 'ref'),
  'slack canvas': act('canvas', 'ref'),
  'slack list': act('list', 'ref'),
  'slack scheduled': act('scheduled', 'ref'),
  'slack attach': attach
}
