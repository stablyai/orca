import { isDeepStrictEqual } from 'node:util'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import {
  codexItemBody,
  codexMessageBlocks,
  codexCommandOutput,
  mcpToolOutput,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { readRecord } from './codex-item-field-readers'
import { historyInvocationFields } from './codex-history-source-facts'

/** Saved presentation supplies only the constraints and sparse payload it actually retains. */
export function constrainSavedHistoryItem(
  saved: AgentJournalRenderItem | null,
  observed: CodexThreadItem
): CodexThreadItem | null {
  const body = saved?.body
  if (!body) {
    return observed
  }
  if (
    body.kind === 'message' &&
    ((body.role === 'user' && observed.type !== 'userMessage') ||
      (body.role === 'reasoning' && observed.type !== 'reasoning') ||
      (body.role === 'assistant' &&
        !['agentMessage', 'imageView', 'imageGeneration'].includes(observed.type)))
  ) {
    return null
  }
  if (
    body.kind === 'tool-call' &&
    !['commandExecution', 'mcpToolCall', 'webSearch', 'collabAgentToolCall', 'fileChange'].includes(
      observed.type
    )
  ) {
    return null
  }
  if (body.kind === 'diff' && observed.type !== 'fileChange') {
    return null
  }
  for (const key of [
    'agentId',
    'parentAgentId',
    'providerParentRef',
    'producerKind',
    'attempt'
  ] as const) {
    if (observed[key] !== undefined && saved && observed[key] !== saved[key]) {
      return null
    }
  }
  const item = { ...observed }
  if (body.kind === 'message') {
    if (item.type === 'userMessage') {
      if (
        body.role !== 'user' ||
        (Object.hasOwn(item, 'content') &&
          !isDeepStrictEqual(body.blocks, codexMessageBlocks(item)))
      ) {
        return null
      }
    } else if (
      (item.type === 'agentMessage' && body.role !== 'assistant') ||
      (item.type === 'reasoning' && body.role !== 'reasoning')
    ) {
      return null
    }
    if (item.type === 'imageView') {
      const image = body.blocks.find((block) => block.type === 'image-ref')
      if (image?.type === 'image-ref' && image.path !== undefined) {
        if (item.path !== undefined && item.path !== image.path) {
          return null
        }
        item.path = image.path
      }
    }
  }
  if (body.kind === 'tool-call') {
    const fields = readRecord(body.input)
    const keys =
      item.type === 'commandExecution'
        ? ['command', 'cwd']
        : item.type === 'collabAgentToolCall'
          ? ['prompt']
          : []
    for (const key of keys) {
      if (fields[key] !== undefined && fields[key] !== null) {
        if (Object.hasOwn(item, key) && !isDeepStrictEqual(item[key], fields[key])) {
          return null
        }
        item[key] = fields[key]
      }
    }
    if (item.type === 'mcpToolCall') {
      if (Object.hasOwn(item, 'arguments') && !isDeepStrictEqual(body.input, item.arguments)) {
        return null
      }
      item.arguments = body.input
      for (const key of ['server', 'tool'] as const) {
        const value = body.mcpIdentity?.[key]
        if (value !== undefined && item[key] !== undefined && item[key] !== value) {
          return null
        }
        if (value !== undefined) {
          item[key] = value
        }
      }
    }
    if (item.type === 'fileChange' && item.changes === undefined && fields.changes !== undefined) {
      item.changes = fields.changes
    }
    const invocation = codexItemBody({
      ...historyInvocationFields(item),
      type: item.type,
      id: item.id
    })
    if (
      body.mcpIdentity &&
      (invocation?.kind !== 'tool-call' ||
        !isDeepStrictEqual(invocation.mcpIdentity, body.mcpIdentity))
    ) {
      return null
    }
    const interpreted = readRecord(invocation?.kind === 'tool-call' ? invocation.input : null)
    for (const key of ['command', 'cwd', 'prompt']) {
      if (
        fields[key] !== undefined &&
        fields[key] !== null &&
        !isDeepStrictEqual(interpreted[key], fields[key])
      ) {
        return null
      }
    }
    if (['commandExecution', 'mcpToolCall', 'collabAgentToolCall'].includes(item.type)) {
      if (body.state !== 'running' && item.status === 'inProgress') {
        return null
      }
      if (
        body.state === 'completed' &&
        ['failed', 'interrupted', 'declined'].includes(String(item.status))
      ) {
        return null
      }
      if (
        body.state === 'failed' &&
        item.status === 'completed' &&
        item.error == null &&
        (item.exitCode == null || item.exitCode === 0)
      ) {
        return null
      }
      if (
        body.exitCode !== undefined &&
        item.exitCode !== undefined &&
        item.exitCode !== body.exitCode
      ) {
        return null
      }
      if (item.type === 'commandExecution') {
        if (body.exitCode !== undefined) {
          item.exitCode = body.exitCode
        }
        if (body.durationMs !== undefined && item.durationMs === undefined) {
          item.durationMs = body.durationMs
        }
      }
      const output =
        item.type === 'commandExecution'
          ? codexCommandOutput(item)
          : item.type === 'mcpToolCall'
            ? mcpToolOutput(item)
            : null
      if (body.output && !body.output.truncated) {
        if (body.state !== 'running' && output !== null && output !== body.output.head) {
          return null
        }
        if (output === null || output === body.output.head) {
          if (item.type === 'commandExecution') {
            item.aggregatedOutput = body.output.head
          }
          if (item.type === 'mcpToolCall' && item.error == null) {
            item.result = { content: [{ type: 'text', text: body.output.head }] }
          }
        }
      }
    }
  }
  return item
}
