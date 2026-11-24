import { z } from 'zod'
import { workerPreferenceLookup } from '../../../shared/commander/worker-preference-instructions'
import { recurringAnswerTitle } from '../../../shared/commander/recurring-answer'
import { dispatchCheckpoint } from './dispatch-checkpoint'
import type { CommanderMemoryRevision } from '../../../shared/commander/memory-contract'
import { checkAgentLaunchModelPreferences } from '../../../shared/agent-launch/choices/agent-launch-model-preferences'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { RuntimeClientError } from '../../runtime/connection/types'

const route = z.strictObject({
  agent: z.string().min(1),
  taskKind: z.string().min(1),
  containsAny: z.array(z.string().trim().min(1)).optional(),
  model: z.string().trim().min(1),
  effort: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(4000)
})
const policy = z.strictObject({ version: z.literal(1), routes: z.array(route) })
const policyTitle = 'Worker model routing'

export function planCommanderDispatch(input: {
  pages: CommanderMemoryRevision[]
  projectId: string
  agent: TuiAgent
  spec: string
  taskKind?: string
  model?: string
  effort?: string
  createsWorktree: boolean
}) {
  const pages = input.pages.filter(
    (page) =>
      !page.deleted &&
      page.kind === 'guideline' &&
      page.actor.type === 'human' &&
      (page.projectId === input.projectId || page.projectId === null)
  )
  const instructions = pages.filter(
    (page) => page.title !== policyTitle && page.title !== recurringAnswerTitle && page.body.trim()
  )
  const ownerGuidelines = instructions
    .map((p) => `Owner guideline: ${p.title} (${p.pageId} v${p.version})\n${p.body}`)
    .join('\n\n')
  // Freeze these instructions into the dispatch so paired hosts and retries get the same prompt.
  const guidelines = [
    ownerGuidelines,
    `${workerPreferenceLookup(input.projectId)} If automatic answers are off, the lookup is unavailable, or no single answer matches, send the exact question to your coordinator using the orchestration ask command in your worker instructions. Wait for the reply. Tool and script approvals follow the host’s permission flow.`
  ]
    .filter(Boolean)
    .join('\n\n')
  const bytes = Buffer.byteLength(guidelines)
  if (bytes > 8192) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Commander guidelines use ${bytes} UTF-8 bytes; the dispatch limit is 8192. Shorten the active guidelines or move background detail into linked notes.`
    )
  }
  const policies = pages.filter((page) => page.title === policyTitle)
  const candidates = policies.flatMap((page) => {
    const entries = policy.parse(JSON.parse(page.body)).routes
    return entries.filter((entry) => entry.agent === input.agent).map((entry) => ({ entry, page }))
  })
  const task = input.spec.toLowerCase()
  const matched = candidates
    .map((candidate) => {
      const { entry, page } = candidate
      const matches = input.taskKind
        ? entry.taskKind === input.taskKind
        : entry.containsAny?.some((word) => task.includes(word.toLowerCase()))
      const rank = matches ? 2 : entry.taskKind === 'default' ? 0 : -2
      return { ...candidate, score: rank + Number(page.projectId === input.projectId) }
    })
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
  if (!input.model && matched.length > 1 && matched[0].score === matched[1].score) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Multiple Commander model rules match this task. Select one task kind or revise the routing guideline.'
    )
  }
  const selected = input.model ? undefined : matched[0]
  const model = input.model ?? selected?.entry.model
  const effort = input.effort ?? selected?.entry.effort
  const checked = checkAgentLaunchModelPreferences({
    agent: input.agent,
    model,
    effort,
    createsWorktree: input.createsWorktree,
    openCodeModelLaunchSupported: true
  })
  if ('refusal' in checked) {
    throw new RuntimeClientError(checked.refusal.code, checked.refusal.message)
  }
  const checkpoint = dispatchCheckpoint(
    input.pages,
    input.projectId,
    8192 - bytes - (guidelines ? 2 : 0)
  )
  const sources = [
    ...instructions,
    ...(selected ? [selected.page] : []),
    ...(checkpoint ? [checkpoint.page] : [])
  ]
  const reason = input.model
    ? 'Caller supplied --model.'
    : (selected?.entry.reason ?? 'No applicable model rule. Use the agent configuration.')
  return {
    model,
    effort,
    reason: input.effort ? `${reason} Caller supplied --effort.` : reason,
    taskKind: input.taskKind ?? selected?.entry.taskKind ?? null,
    guidelines: [guidelines, checkpoint?.excerpt].filter(Boolean).join('\n\n'),
    sources: sources.map(({ pageId, version }) => ({ pageId, version }))
  }
}
