import { attributeUsageEvent } from '../usage/worktree-attribution/usage-event-attribution'
import { createUsageEventAggregation } from '../usage/rollups/usage-event-aggregation'
import { readJsonlLinesFromOffset } from '../usage/source-input/jsonl/jsonl-line-offsets'
import type { UsageScanWorktreeRef } from '../usage/provider-lifecycle/usage-provider-contract'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/worktree-attribution/usage-worktree-resolver'
import {
  listAntigravityTranscriptFiles,
  resolveAntigravityUsageBrainDirs,
  type AntigravityTranscriptRef
} from './antigravity-transcript-discovery'
import {
  consumeAntigravityUsageLine,
  createAntigravityTranscriptAccumulator
} from './antigravity-usage-record-parser'
import { createAntigravityWorkspaceLookup } from './antigravity-workspace-lookup'
import type {
  AntigravityOpeningPrompt,
  AntigravityUsageAttributedEvent,
  AntigravityUsageDailyAggregate,
  AntigravityUsageMetric,
  AntigravityUsageParsedStep,
  AntigravityUsagePersistedFile,
  AntigravityUsageSession
} from './types'

const YIELD_EVERY_FILES = 10
const MAX_SUBAGENT_DEPTH = 8

export const antigravityUsageAggregation = createUsageEventAggregation<
  AntigravityUsageAttributedEvent,
  AntigravityUsageMetric
>({
  metric: { empty: () => ({}), fromEvent: () => ({}), fold: () => {} },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

type ParsedTranscriptContent = {
  openingPrompt: AntigravityOpeningPrompt | null
  childConversationIds: string[]
  steps: AntigravityUsageParsedStep[]
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

export async function readAntigravityTranscriptContent(
  filePath: string,
  conversationId: string
): Promise<ParsedTranscriptContent> {
  const acc = createAntigravityTranscriptAccumulator(conversationId)
  for await (const { line } of readJsonlLinesFromOffset(filePath, 0)) {
    consumeAntigravityUsageLine(line, acc)
  }
  return {
    openingPrompt: acc.openingPrompt,
    childConversationIds: [...acc.childConversationIds].sort((a, b) => a.localeCompare(b)),
    steps: [...acc.stepsByKey.values()]
  }
}

function resolveRootConversation(
  conversationId: string,
  parentByChildLower: Map<string, string>,
  canonicalIdByLower: Map<string, string>
): { rootSessionId: string; chainLower: string[] } {
  const startLower = conversationId.toLowerCase()
  const chainLower = [startLower]
  const visited = new Set<string>([startLower])
  let currentLower = startLower
  for (let depth = 0; depth < MAX_SUBAGENT_DEPTH; depth++) {
    const parentLower = parentByChildLower.get(currentLower)
    if (!parentLower || visited.has(parentLower)) {
      break
    }
    visited.add(parentLower)
    chainLower.push(parentLower)
    currentLower = parentLower
  }
  const rootSessionId = canonicalIdByLower.get(currentLower) ?? conversationId
  return { rootSessionId, chainLower }
}

function buildPersistedFileFromParsed(input: {
  ref: AntigravityTranscriptRef
  parsed: ParsedTranscriptContent
  effectiveSessionId: string
  effectiveCwd: string | null
  resolveWorktree: UsageWorktreeResolver
  claimEventKey: (eventKey: string) => boolean
}): AntigravityUsagePersistedFile {
  const events: AntigravityUsageAttributedEvent[] = []
  const ownedEventKeys = new Set<string>()
  let hasDeferredClaims = false

  for (const step of input.parsed.steps) {
    if (!input.claimEventKey(step.eventKey)) {
      hasDeferredClaims = true
      continue
    }
    ownedEventKeys.add(step.eventKey)
    const attributed = attributeUsageEvent(
      {
        ...step,
        sessionId: input.effectiveSessionId,
        cwd: input.effectiveCwd
      },
      input.resolveWorktree
    )
    if (attributed) {
      events.push(attributed)
    }
  }

  return {
    path: input.ref.path,
    mtimeMs: input.ref.mtimeMs,
    size: input.ref.size,
    conversationId: input.ref.conversationId,
    effectiveSessionId: input.effectiveSessionId,
    effectiveCwd: input.effectiveCwd,
    openingPrompt: input.parsed.openingPrompt,
    childConversationIds: input.parsed.childConversationIds,
    ...antigravityUsageAggregation.aggregate(events),
    ownedEventKeys: [...ownedEventKeys],
    hasDeferredClaims
  }
}

export async function scanAntigravityUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previousProcessedFiles: AntigravityUsagePersistedFile[],
  onFilesScanned?: (count: number) => void,
  brainDirs: readonly string[] = resolveAntigravityUsageBrainDirs({})
): Promise<{
  processedFiles: AntigravityUsagePersistedFile[]
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
}> {
  const refs = await listAntigravityTranscriptFiles(brainDirs)
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)
  const workspaceLookup = createAntigravityWorkspaceLookup()

  const currentPaths = new Set(refs.map((ref) => ref.path))
  const lostOwnerPath = previousProcessedFiles.some(
    (file) => !currentPaths.has(file.path) && file.ownedEventKeys.length > 0
  )

  const parsedByPath = new Map<string, ParsedTranscriptContent>()
  const metadataByPath = new Map<
    string,
    { openingPrompt: AntigravityOpeningPrompt | null; childConversationIds: string[] }
  >()
  const activeRefs: AntigravityTranscriptRef[] = []
  let readCount = 0

  for (const ref of refs) {
    const previous = previousByPath.get(ref.path)
    const statMatches =
      previous !== undefined &&
      previous.mtimeMs === ref.mtimeMs &&
      previous.size === ref.size &&
      !(lostOwnerPath && previous.hasDeferredClaims)
    if (statMatches) {
      metadataByPath.set(ref.path, {
        openingPrompt: previous.openingPrompt,
        childConversationIds: previous.childConversationIds
      })
      activeRefs.push(ref)
      continue
    }
    try {
      const parsed = await readAntigravityTranscriptContent(ref.path, ref.conversationId)
      parsedByPath.set(ref.path, parsed)
      metadataByPath.set(ref.path, {
        openingPrompt: parsed.openingPrompt,
        childConversationIds: parsed.childConversationIds
      })
      activeRefs.push(ref)
    } catch {
      // Retry vanished or unreadable transcripts on the next scan.
    }
    onFilesScanned?.(1)
    readCount++
    if (readCount % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const canonicalIdByLower = new Map<string, string>()
  const parentByChildLower = new Map<string, string>()
  for (const ref of activeRefs) {
    const parentLower = ref.conversationId.toLowerCase()
    if (!canonicalIdByLower.has(parentLower)) {
      canonicalIdByLower.set(parentLower, ref.conversationId)
    }
    for (const childLower of metadataByPath.get(ref.path)?.childConversationIds ?? []) {
      if (!parentByChildLower.has(childLower)) {
        parentByChildLower.set(childLower, parentLower)
      }
    }
  }

  const ownCwdByLower = new Map<string, string | null>()
  for (const [index, ref] of activeRefs.entries()) {
    const lower = ref.conversationId.toLowerCase()
    const meta = metadataByPath.get(ref.path)
    const resolved = await workspaceLookup.resolve(
      ref.appDataDir,
      ref.conversationId,
      meta?.openingPrompt ?? null
    )
    if (resolved && !ownCwdByLower.get(lower)) {
      ownCwdByLower.set(lower, resolved)
    } else if (!ownCwdByLower.has(lower)) {
      ownCwdByLower.set(lower, null)
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const resolvedContextByPath = new Map<
    string,
    { effectiveSessionId: string; effectiveCwd: string | null }
  >()
  for (const ref of activeRefs) {
    const { rootSessionId, chainLower } = resolveRootConversation(
      ref.conversationId,
      parentByChildLower,
      canonicalIdByLower
    )
    const effectiveCwd =
      chainLower.map((id) => ownCwdByLower.get(id) ?? null).find((cwd) => cwd !== null) ?? null
    resolvedContextByPath.set(ref.path, { effectiveSessionId: rootSessionId, effectiveCwd })
  }

  const eventOwnerByKey = new Map<string, string>()
  const canReusePrevious = (ref: AntigravityTranscriptRef): boolean => {
    const previous = previousByPath.get(ref.path)
    const context = resolvedContextByPath.get(ref.path)
    return (
      previous !== undefined &&
      context !== undefined &&
      !parsedByPath.has(ref.path) &&
      !(lostOwnerPath && previous.hasDeferredClaims) &&
      previous.mtimeMs === ref.mtimeMs &&
      previous.size === ref.size &&
      previous.effectiveSessionId === context.effectiveSessionId &&
      previous.effectiveCwd === context.effectiveCwd
    )
  }

  for (const ref of activeRefs) {
    if (canReusePrevious(ref)) {
      for (const eventKey of previousByPath.get(ref.path)?.ownedEventKeys ?? []) {
        if (!eventOwnerByKey.has(eventKey)) {
          eventOwnerByKey.set(eventKey, ref.path)
        }
      }
    }
  }

  const claimFor =
    (path: string) =>
    (eventKey: string): boolean => {
      const owner = eventOwnerByKey.get(eventKey)
      if (owner !== undefined && owner !== path) {
        return false
      }
      eventOwnerByKey.set(eventKey, path)
      return true
    }

  const processedFiles: AntigravityUsagePersistedFile[] = []
  const sessionsById = new Map<string, AntigravityUsageSession>()
  const dailyByKey = new Map<string, AntigravityUsageDailyAggregate>()

  for (const ref of activeRefs) {
    const previous = previousByPath.get(ref.path)
    const context = resolvedContextByPath.get(ref.path)!
    let processed: AntigravityUsagePersistedFile | undefined

    if (previous && canReusePrevious(ref)) {
      processed = previous
    } else {
      let parsed = parsedByPath.get(ref.path)
      if (!parsed) {
        try {
          parsed = await readAntigravityTranscriptContent(ref.path, ref.conversationId)
        } catch {
          continue
        }
        onFilesScanned?.(1)
      }
      processed = buildPersistedFileFromParsed({
        ref,
        parsed,
        effectiveSessionId: context.effectiveSessionId,
        effectiveCwd: context.effectiveCwd,
        resolveWorktree,
        claimEventKey: claimFor(ref.path)
      })
    }

    processedFiles.push(processed)
    antigravityUsageAggregation.mergeSessions(sessionsById, processed.sessions)
    antigravityUsageAggregation.mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: antigravityUsageAggregation.finalizeSessions(sessionsById),
    dailyAggregates: antigravityUsageAggregation.sortDailyAggregates(dailyByKey)
  }
}
