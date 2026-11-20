import { z } from 'zod'
import { EpochMsSchema } from '@orca-cloud/push-contract'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import {
  CONNECTOR_SOURCES,
  ConnectorConversationSchema,
  ConnectorPostNoticesSchema,
  ConnectorTurnForSchema
} from './connector-wire-scalars.js'

// The shared verbs a bot takes in a source; a source that doesn't take one answers it as unsupported.
// Reply is `orca bot reply`, listed so capabilities name it; it answers the run's own conversation,
// never a ref.
export const CONNECTOR_ACTION_VERBS = [
  'reply',
  'react',
  'read',
  'post',
  'find',
  'check',
  'edit',
  'delete',
  'attach',
  'set'
] as const
export type ConnectorActionVerb = (typeof CONNECTOR_ACTION_VERBS)[number]

// Sources a bot acts in: any but a hook, which has no place to act on.
export type ConnectorActionSource = Exclude<(typeof CONNECTOR_SOURCES)[number], 'webhook'>

/**
 * A place or message in a source, by its stable ids only: the existing ThreadPlace plus its source and
 * an optional message. Display keys (ENG-42, owner/repo#17, #name) are input, never a ref.
 */
export type ConnectorRef = {
  source: ConnectorActionSource
  workspaceId: string
  containerId: string
  threadId?: string
  messageId?: string
}

// A whole workspace as a place (slack:T1:workspace, linear:<org>:workspace): a rule listening anywhere in it.
// No source names a container this, so it reads as no channel, repo, issue or team.
export const CONNECTOR_WORKSPACE_CONTAINER = 'workspace'

export const workspaceRef = (source: ConnectorActionSource, workspaceId: string): ConnectorRef => ({
  source,
  workspaceId,
  containerId: CONNECTOR_WORKSPACE_CONTAINER
})

// A person in a workspace (slack:T1:user:U1): what find names someone by. No place, so no verb but
// find acts on one.
export const CONNECTOR_USER_CONTAINER = 'user'

export const userRef = (source: ConnectorActionSource, workspaceId: string, userId: string): ConnectorRef => ({
  source,
  workspaceId,
  containerId: CONNECTOR_USER_CONTAINER,
  threadId: userId
})

export const isWorkspaceRef = (ref: ConnectorRef): boolean =>
  ref.containerId === CONNECTOR_WORKSPACE_CONTAINER &&
  ref.threadId === undefined &&
  ref.messageId === undefined

const ACTION_SOURCES: readonly string[] = CONNECTOR_SOURCES.filter((source) => source !== 'webhook')

function isActionSource(source: string): source is ConnectorActionSource {
  return ACTION_SOURCES.includes(source)
}

/**
 * `source:workspace:container[:thread][:message]`, each id percent-encoded. The thread slot holds a
 * thread's root only: a message not in a thread leaves it empty (`slack:T1:C1::1712.0001`).
 */
export function formatConnectorRef(ref: ConnectorRef): string {
  // An empty id would write a ref that reads back as none.
  for (const id of [ref.workspaceId, ref.containerId, ref.threadId, ref.messageId]) {
    if (id === '') {
      throw new Error('A connector ref takes no empty id.')
    }
  }
  const ids = [ref.workspaceId, ref.containerId]
  if (ref.messageId !== undefined) {
    ids.push(ref.threadId ?? '', ref.messageId)
  } else if (ref.threadId !== undefined) {
    ids.push(ref.threadId)
  }
  return [ref.source, ...ids.map((id) => encodeURIComponent(id))].join(':')
}

const validId = (id: string | undefined) =>
  id !== undefined && id.length > 0 && id.length <= CONNECTOR_LIMITS.maxBotIdLength

/** Null for anything that isn't a ref in this grammar; only the cloud reads one. */
export function parseConnectorRef(raw: string): ConnectorRef | null {
  const [source, ...rest] = raw.trim().split(':')
  if (!source || !isActionSource(source) || rest.length < 2 || rest.length > 4) {
    return null
  }
  let ids: string[]
  try {
    ids = rest.map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
  const [workspaceId, containerId, threadId, messageId] = ids
  // Only a message's thread slot may be empty.
  const threadOk = threadId === undefined || validId(threadId) || (threadId === '' && messageId !== undefined)
  if (!validId(workspaceId) || !validId(containerId) || !threadOk || (messageId !== undefined && !validId(messageId))) {
    return null
  }
  return {
    source,
    workspaceId: workspaceId!,
    containerId: containerId!,
    ...(threadId ? { threadId } : {}),
    ...(messageId === undefined ? {} : { messageId })
  }
}

// What a person reads beside a ref: "#infra", "ENG-42 Login fails", "Dana: deploys are failing".
const Label = z.string().max(CONNECTOR_LIMITS.maxDisplayTextLength)
// exact: find's input names this place and nothing else (an id, a link, a whole #name or key). key:
// the id or key an older peer names it by (C0123ABCD, ENG-42), on find with `of` where there is one.
export const ConnectorRefViewSchema = z.object({
  ref: z.string().min(1),
  label: Label,
  exact: z.literal(true).optional(),
  key: z.string().max(CONNECTOR_LIMITS.maxDisplayTextLength).optional()
})
export type ConnectorRefView = z.infer<typeof ConnectorRefViewSchema>

export const ConnectorActionCapabilitySchema = z.object({
  status: z.enum(['yes', 'partial', 'no']),
  reason: z.string().max(CONNECTOR_LIMITS.maxDisplayTextLength).optional(),
  // Who the source shows as acting: the bot, or a connected person where the service forces it.
  actor: z.enum(['bot', 'user']),
  limits: z.record(z.string(), z.unknown()).optional()
})
export type ConnectorActionCapability = z.infer<typeof ConnectorActionCapabilitySchema>

export const ConnectorSourceCapabilitiesSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  // The bot's place in the source, as a ref, when it has one (Slack: its workspace).
  workspace: ConnectorRefViewSchema.optional(),
  verbs: z.partialRecord(z.enum(CONNECTOR_ACTION_VERBS), ConnectorActionCapabilitySchema),
  // Where the owner approves what the bot's app newly needs, when it does.
  approveUrl: z.string().max(2048).optional()
})
export type ConnectorSourceCapabilities = z.infer<typeof ConnectorSourceCapabilitiesSchema>

const ACT_ARGS_MAX_TEXT = 40_000

// A file's bytes inline, as base64, from a machine that predates `files.direct`; only the request's
// own size bounds it. A newer machine sends `upload` and the bytes go straight to the source.
export const ConnectorAttachedFileSchema = z
  .object({
    name: z.string().min(1).max(255),
    // Base64 of the file's bytes.
    data: z.string().min(1)
  })
  .strict()
export type ConnectorAttachedFile = z.infer<typeof ConnectorAttachedFileSchema>

// A file the machine uploads itself: its name and exact size, which the source's upload slot is cut
// for. The source's own limits are the only ones. Sent only to a cloud listing `files.direct`.
export const ConnectorUploadSchema = z
  .object({
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type ConnectorUpload = z.infer<typeof ConnectorUploadSchema>
// The most files one `orca bot reply` posts with its words.
export const CONNECTOR_REPLY_MAX_FILES = 10

const SEARCH_NAME = z.string().trim().min(1).max(100)
// state: a state's name, or `open` for any not done or canceled.
export const ConnectorSearchSchema = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    state: SEARCH_NAME.optional(),
    assignee: SEARCH_NAME.optional(),
    label: SEARCH_NAME.optional()
  })
  .strict()
export type ConnectorSearch = z.infer<typeof ConnectorSearchSchema>

// set: an issue's fields by the names a person uses; null clears one. Sent only to a cloud listing `set`.
export const CONNECTOR_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export const ConnectorFieldsSchema = z
  .object({
    state: SEARCH_NAME.optional(),
    assignee: SEARCH_NAME.nullable().optional(),
    delegate: SEARCH_NAME.nullable().optional(),
    priority: z.enum(CONNECTOR_PRIORITIES).optional(),
    addLabels: z.array(SEARCH_NAME).min(1).max(10).optional(),
    removeLabels: z.array(SEARCH_NAME).min(1).max(10).optional(),
    estimate: z.number().int().min(0).max(1000).nullable().optional()
  })
  .strict()
export type ConnectorFields = z.infer<typeof ConnectorFieldsSchema>

// Each verb's arguments; anything else a verb doesn't read is refused, not ignored.
export const ConnectorActionArgsSchema = z
  .object({
    emoji: z.string().min(1).max(100).optional(),
    remove: z.literal(true).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().min(1).max(2048).optional(),
    text: z.string().min(1).max(ACT_ARGS_MAX_TEXT).optional(),
    join: z.literal(true).optional(),
    // A post's idempotency key, minted once by the CLI: a retry with it never posts twice.
    postId: z.string().min(1).max(128).optional(),
    // post: when to post it (epoch seconds), for the source to send then by itself. Sent only to a
    // cloud listing `post.schedule`.
    postAt: z.number().int().positive().optional(),
    // attach: the file, posted with text as its comment (a machine before `files.direct`).
    file: ConnectorAttachedFileSchema.optional(),
    // reply and attach, with stage: a file the machine uploads itself. The answer's `upload.url` takes
    // its bytes; the file is shown once a reply or attach names its postId in `files`.
    upload: ConnectorUploadSchema.optional(),
    // reply (and attach, with upload): hold the file, uploaded but not yet shown, for the reply or
    // attach that names its postId in `files`. Sent only to a cloud listing `reply.files`.
    stage: z.literal(true).optional(),
    // reply and attach: the postIds of files staged for it, posted with its text as one post. attach
    // takes them only from a cloud listing `files.direct`.
    files: z.array(z.string().min(1).max(128)).min(1).max(CONNECTOR_REPLY_MAX_FILES).optional(),
    // read: the id of a file on the message read, to download it.
    download: z.string().min(1).max(64).optional(),
    // read, with download: answer a link the machine streams the bytes from, not the bytes inline.
    // Sent only to a cloud listing `files.direct`.
    stream: z.literal(true).optional(),
    // find: each match as what a rule or a result names (a channel, repo or team; a thread, issue or
    // pull request), leaving out matches that name neither. Sent only to a cloud listing `refs`.
    of: z.enum(['place', 'subject']).optional(),
    // find: the workspace (a workspace ref) to look a person up in.
    workspace: z.string().min(1).max(2048).optional(),
    // find: what in a place (Linear: a team's or workspace's issues) matches words and filters, by
    // name as a person says them. Sent only to a cloud listing `find.search`.
    search: ConnectorSearchSchema.optional(),
    fields: ConnectorFieldsSchema.optional(),
    // post: a title makes a post to a team a new issue there, with `fields`, under `parent` (an issue
    // key, link or ref) when given. Sent only to a cloud listing `create`.
    title: z.string().trim().min(1).max(255).optional(),
    parent: z.string().min(1).max(2048).optional()
  })
  .strict()
export type ConnectorActionArgs = z.infer<typeof ConnectorActionArgsSchema>

export const ConnectorActionRequestSchema = z.object({
  v: z.literal(1),
  botId: z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength),
  // places: sent only to a cloud listing `places`.
  verb: z.enum([...CONNECTOR_ACTION_VERBS, 'capabilities', 'places']),
  // A ref, or input the cloud resolves to one: a link, a #name, an issue key.
  ref: z.string().min(1).max(2048).optional(),
  args: ConnectorActionArgsSchema.default({}),
  // The conversation the calling run answers, if any: whose workspace a person lookup stays in.
  conversation: ConnectorConversationSchema.optional(),
  // The turn of it the run is in (its turn-started `at`): only that turn acts as whoever started it.
  turnId: EpochMsSchema.optional(),
  // Whom the run's turn acts for when no delivery started it (see ConnectorTurnForSchema).
  turnFor: ConnectorTurnForSchema.optional()
})
export type ConnectorActionRequest = z.infer<typeof ConnectorActionRequestSchema>

// A file posted on a message: its id downloads it (`read <message> --download <id>`).
export const ConnectorMessageFileSchema = z.object({
  id: z.string(),
  // As Slack names it, whole: saving the file uses it.
  name: z.string().max(1024),
  type: z.string().optional(),
  size: z.number().int().nonnegative().optional()
})

export const ConnectorReadMessageSchema = ConnectorRefViewSchema.extend({
  author: Label,
  text: z.string(),
  at: z.number().int().nonnegative(),
  // Its web link, where the source has one.
  url: z.string().url().optional(),
  files: z.array(ConnectorMessageFileSchema).optional()
})

// A workspace the bot is in, as a place, with the places in it a rule names (Linear: its teams).
export const ConnectorWorkspaceViewSchema = ConnectorRefViewSchema.extend({
  source: z.enum(CONNECTOR_SOURCES),
  places: z.array(ConnectorRefViewSchema).optional()
})
export type ConnectorWorkspaceView = z.infer<typeof ConnectorWorkspaceViewSchema>

// An issue's own fields, on read; each is left out when unset. Linked issues are refs.
export const ConnectorIssueFactsSchema = z.looseObject({
  url: z.string().optional(),
  // type: the source's kind of state (Linear: triage, backlog, unstarted, started, completed, canceled).
  state: z.object({ name: Label, type: z.string() }).optional(),
  team: Label.optional(),
  priority: Label.optional(),
  assignee: Label.optional(),
  delegate: Label.optional(),
  labels: z.array(Label).optional(),
  // More labels than are listed.
  moreLabels: z.literal(true).optional(),
  project: Label.optional(),
  cycle: Label.optional(),
  estimate: z.number().optional(),
  // YYYY-MM-DD.
  due: z.string().optional(),
  parent: ConnectorRefViewSchema.optional(),
  children: z.array(ConnectorRefViewSchema).optional(),
  // More children than are listed.
  moreChildren: z.literal(true).optional()
})
export type ConnectorIssueFacts = z.infer<typeof ConnectorIssueFactsSchema>

// Each verb's answer; the machine passes it on as it is, so a newer cloud's fields reach the CLI.
export const ConnectorActionResultSchema = z.looseObject({
  // The place or message acted on, or made (post).
  target: ConnectorRefViewSchema.optional(),
  // A post Orca Cloud took and sends shortly; target is then its place, not the message.
  queued: z.literal(true).optional(),
  // A post that has gone: the message's web link, where the source has one.
  url: z.string().url().optional(),
  // A post's: why it can't wake an Orca bot it mentions.
  notices: ConnectorPostNoticesSchema.optional(),
  // A post that made a new issue; target is the issue.
  created: z.literal(true).optional(),
  // A reply's file held for the reply that names it.
  staged: z.literal(true).optional(),
  // A staged upload: where the machine POSTs the file's bytes, as they are. The URL is the source's
  // own and needs no credential; the file is shown nowhere until a post names its postId.
  upload: z.object({ url: z.string().url() }).optional(),
  messages: z.array(ConnectorReadMessageSchema).optional(),
  // The ref to pass as --before for the next older page; absent on the last.
  before: z.string().optional(),
  // What a read left out, in words (a thread past what Orca reads at once).
  note: z.string().optional(),
  // A file read with --download: its bytes as base64 for a machine before `files.direct`; for one
  // that asked to stream, where to GET them, with the ticket as its bearer credential. The answer
  // streams the source's bytes as they come, takes a Range to resume, and is good until the ticket
  // expires.
  download: ConnectorMessageFileSchema.extend({
    data: z.string().optional(),
    url: z.string().url().optional(),
    ticket: z.string().min(1).optional()
  }).optional(),
  // find: each match, and for a message search what it says (bounded), so the bot needn't open it.
  matches: z.array(ConnectorRefViewSchema.extend({ text: z.string().optional() })).optional(),
  // read: the issue's own fields, where the source has them.
  facts: ConnectorIssueFactsSchema.optional(),
  access: z
    .object({
      member: z.boolean(),
      canRead: z.boolean(),
      canPost: z.boolean(),
      // How the bot gets in, when it isn't.
      howToJoin: z.string().optional(),
      joined: z.literal(true).optional()
    })
    .optional(),
  sources: z.array(ConnectorSourceCapabilitiesSchema).optional(),
  workspaces: z.array(ConnectorWorkspaceViewSchema).optional()
})
export type ConnectorActionResult = z.infer<typeof ConnectorActionResultSchema>

// Refused: why in a code, and what to do in words a bot can act on.
export const ConnectorActionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: ConnectorActionResultSchema }),
  z.object({
    ok: z.literal(false),
    refusal: z.string().min(1).max(64),
    message: z.string().max(CONNECTOR_LIMITS.maxDisplayTextLength * 4)
  })
])
export type ConnectorActionResponse = z.infer<typeof ConnectorActionResponseSchema>
