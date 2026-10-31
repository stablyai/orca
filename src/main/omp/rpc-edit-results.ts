import { z } from 'zod'
import { boundedDiffPatch } from '../native-chat/bounded-diff-patch'
import { ompNativeToolResults } from './rpc-tool-results'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { journalPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'

const editSchema = z.object({
  path: z.string().min(1),
  diff: z.string().min(1),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  op: z.string().optional(),
  sourcePath: z.string().optional()
})

export function ompResolvedEdits(
  details: unknown,
  toolName?: string,
  returnedOnly = false
): { path: string; patch: string }[] {
  const root = z.record(z.string(), z.unknown()).safeParse(details)
  if (!root.success) {
    return []
  }
  const edits: { path: string; patch: string }[] = []
  for (const result of ompNativeToolResults(root.data, toolName)) {
    if (returnedOnly && !result.returned) {
      continue
    }
    if (result.toolName !== 'edit' && !result.returned) {
      continue
    }
    const candidates = Array.isArray(result.details.perFileResults)
      ? result.details.perFileResults
      : [result.details]
    for (const candidate of candidates) {
      const parsed = editSchema.safeParse(candidate)
      if (!parsed.success) {
        continue
      }
      const file = parsed.data
      const oldText = file.oldText ?? (file.op === 'create' ? '' : undefined)
      const newText = file.newText ?? (file.op === 'delete' ? '' : undefined)
      let patch =
        oldText !== undefined && newText !== undefined
          ? boundedDiffPatch(file.path, oldText, newText)
          : /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(file.diff)
            ? file.diff
            : undefined
      if (patch) {
        if (file.op === 'create') {
          patch = patch.replace(/^---[^\n]*/m, '--- /dev/null')
        } else if (file.op === 'delete') {
          patch = patch.replace(/^\+\+\+[^\n]*/m, '+++ /dev/null')
        } else if (file.sourcePath && file.sourcePath !== file.path) {
          const renamed = patch.replace(/^---[^\n]*/m, () => `--- ${file.sourcePath}`)
          patch = `diff --git a/${file.sourcePath} b/${file.path}\n${renamed}`
        }
        edits.push({ path: file.path, patch })
      }
    }
  }
  return edits
}

export function ompEditResultEvents(frame: JsonlRpcRecord): ProviderTimelineEvent[] {
  if (
    !['tool_execution_end', 'tool_execution_update'].includes(frame.type) ||
    typeof frame.toolCallId !== 'string'
  ) {
    return []
  }
  const ended = frame.type === 'tool_execution_end'
  const result = z
    .object({ details: z.unknown() })
    .safeParse(ended ? frame.result : frame.partialResult)
  if (!result.success) {
    return []
  }
  return ompResolvedEdits(
    result.data.details,
    typeof frame.toolName === 'string' ? frame.toolName : undefined,
    !ended
  ).map((file, index) => ({
    type: 'item.close',
    item: `omp-diff:${JSON.stringify([frame.toolCallId, index, file.path])}`,
    body: { kind: 'diff', path: file.path, patch: journalPayload(file.patch) }
  }))
}

export function ompHistoricalEditBlocks(
  details: unknown,
  toolName: string | undefined
): NativeChatBlock[] {
  return ompResolvedEdits(details, toolName).flatMap((file): NativeChatBlock[] => [
    { type: 'tool-call', name: 'Diff', input: { path: file.path }, state: 'completed' },
    { type: 'tool-result', output: file.patch }
  ])
}
