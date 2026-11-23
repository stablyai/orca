import * as z from 'zod'
import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent-config'

// The page reaches only its own desktop; the shell holds every paired host, so it shows the Fork sheet.
export const BRIDGE_CHAT_FORK_VERB = 'native.chat.fork'

const ID_MAX_CHARS = 512
const LABEL_MAX_CHARS = 1024
// A recap is cut to the session context budget (36k chars) plus its framing; a longer one is not sent.
export const BRIDGE_CHAT_FORK_RECAP_MAX_CHARS = 64_000

const idSchema = z.string().min(1).max(ID_MAX_CHARS)
const agentSchema = z.custom<TuiAgent>((value) => isTuiAgent(value))
const surfaceSchema = z.enum(['chat', 'terminal'])
const capabilitiesSchema = z.array(z.string().min(1).max(128)).max(1024)
const recapSchema = z.string().min(1).max(BRIDGE_CHAT_FORK_RECAP_MAX_CHARS).nullable()

// The page's word on its own chat; the source host is the shell's, never a page field.
export const chatForkParamsSchema = z.strictObject({
  worktreeId: idSchema,
  agent: agentSchema,
  surface: surfaceSchema,
  usageLimited: z.boolean(),
  canCopy: z.boolean(),
  canExport: z.boolean(),
  canNewWorktree: z.boolean(),
  canSubagent: z.boolean(),
  capabilities: capabilitiesSchema,
  preset: z.enum(['worktree', 'subagent']).nullable(),
  forkFrom: z.strictObject({ sessionId: idSchema, throughItemId: idSchema }),
  recaps: z.strictObject({ history: recapSchema, current: recapSchema })
})

export type BridgeChatForkParams = z.infer<typeof chatForkParamsSchema>

const workspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('this') }),
  z.strictObject({ kind: z.literal('new') }),
  z.strictObject({
    kind: z.literal('existing'),
    hostId: idSchema,
    worktreeId: idSchema,
    name: z.string().max(LABEL_MAX_CHARS)
  })
])

const targetSchema = z.strictObject({
  hostId: idSchema,
  hostLabel: z.string().max(LABEL_MAX_CHARS),
  hostCapabilities: capabilitiesSchema.optional(),
  workspace: workspaceSchema,
  agent: agentSchema,
  runAs: z.enum(['open', 'subagent']),
  path: z.enum(['same', 'relay', 'recap']),
  openAs: surfaceSchema,
  recapScope: z.enum(['history', 'current'])
})

// `here`: a fork on the page's own host, which only the page can run; `done`: the shell ran it on
// another host and hands back what the page should say.
export const chatForkResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('cancelled') }),
  z.strictObject({ outcome: z.literal('here'), target: targetSchema }),
  z.strictObject({
    outcome: z.literal('done'),
    notices: z.array(z.string().min(1).max(LABEL_MAX_CHARS)).max(8)
  })
])

export type BridgeChatForkResult = z.infer<typeof chatForkResultSchema>

export type BridgeChatForkCall = (params: BridgeChatForkParams) => Promise<BridgeChatForkResult>
