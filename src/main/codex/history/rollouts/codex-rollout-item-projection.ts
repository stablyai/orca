import {
  finishTranscriptWork,
  type TranscriptWork
} from '../../../native-chat/transcript-work-scheduler'
import { sortTranscriptWork } from '../../../native-chat/transcript-sort-work'
import { readRecord, readString } from '../../app-server/codex-item-field-readers'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { CodexThreadItem } from '../../structured/items/codex-thread-item-identity'
import {
  fileUriToFilesystemPath,
  filesystemPathToFileUri
} from '../../../../shared/file-links/file-uri-path'
import { codexCommandPresentation, redactCodexCommand } from './codex-command-presentation'

const ITEM_TYPES = new Map(
  [
    'UserMessage',
    'FunctionCallOutput',
    'HookPrompt',
    'AgentMessage',
    'Plan',
    'Reasoning',
    'CommandExecution',
    'DynamicToolCall',
    'CollabAgentToolCall',
    'SubAgentActivity',
    'WebSearch',
    'ImageView',
    'ImageGeneration',
    'EnteredReviewMode',
    'ExitedReviewMode',
    'FileChange',
    'McpToolCall',
    'ContextCompaction'
  ].map((type) => [type, type[0]!.toLowerCase() + type.slice(1)])
)
const EXTENSIONS = new Map<string, string>([
  ['clock.sleep', 'sleep'],
  ['web.search', 'webSearch'],
  ['image_gen.generation', 'imageGeneration']
])

function filesystemPath(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('file:')) {
    return value
  }
  try {
    return fileUriToFilesystemPath(new URL(value)) ?? value
  } catch {
    return value
  }
}

function readPath(path: string, cwd: unknown): string | null {
  if (typeof cwd !== 'string') {
    return null
  }
  try {
    const base = cwd.startsWith('file:') ? fileUriToFilesystemPath(new URL(cwd)) : cwd
    if (!base || path.includes('\0')) {
      return null
    }
    const paths = isWindowsAbsolutePathLike(base) ? win32 : posix
    if (
      paths === win32 &&
      /^[A-Za-z]:(?![\\/])/.test(path) &&
      path.slice(0, 2).toLowerCase() !== base.slice(0, 2).toLowerCase()
    ) {
      return null
    }
    return fileUriToFilesystemPath(new URL(filesystemPathToFileUri(paths.resolve(base, path))))
  } catch {
    return null
  }
}

function* commandActionsWork(
  value: unknown,
  cwd: unknown
): TranscriptWork<Record<string, unknown>[]> {
  const actions: Record<string, unknown>[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    yield 1
    const action = readRecord(raw)
    const command = typeof action.cmd === 'string' ? redactCodexCommand(action.cmd) : ''
    if (action.type === 'read') {
      const path = typeof action.path === 'string' ? readPath(action.path, cwd) : null
      if (path !== null) {
        actions.push({ type: 'read', command, name: action.name, path })
      }
      continue
    }
    if (action.type === 'search') {
      actions.push({
        type: 'search',
        command,
        query: typeof action.query === 'string' ? redactCodexCommand(action.query) : null,
        path: action.path
      })
      continue
    }
    if (action.type === 'list_files') {
      actions.push({ type: 'listFiles', command, path: action.path })
      continue
    }
    actions.push({ type: 'unknown', command })
  }
  return actions
}

export function codexRolloutItem(value: unknown): CodexThreadItem | null {
  return finishTranscriptWork(codexRolloutItemWork(value))
}

export function* codexRolloutItemWork(value: unknown): TranscriptWork<CodexThreadItem | null> {
  const raw = readRecord(value)
  const id = readString(raw, 'id') ?? ''
  const tag = readString(raw, 'type')
  if (!tag) {
    return null
  }
  const type =
    ITEM_TYPES.get(tag) ??
    (tag === 'command_execution'
      ? 'commandExecution'
      : tag === 'file_change'
        ? 'fileChange'
        : tag === 'Extension'
          ? (EXTENSIONS.get(String(raw.kind)) ?? 'extension')
          : tag[0]!.toLowerCase() + tag.slice(1))
  const item: CodexThreadItem = { ...raw, type, id }
  if (raw.status === 'in_progress') {
    item.status = 'inProgress'
  }
  if (!ITEM_TYPES.has(tag) && /^[A-Z]/.test(tag)) {
    item.persistedType = tag
  }
  if (type === 'commandExecution' && Array.isArray(raw.command)) {
    const command: string[] = []
    for (const part of raw.command) {
      yield 1
      if (typeof part === 'string') {
        command.push(part)
      }
    }
    item.command = codexCommandPresentation(command)
    item.cwd = filesystemPath(raw.cwd)
    item.commandActions = yield* commandActionsWork(raw.parsed_cmd, raw.cwd)
    item.processId = raw.process_id
    item.source = raw.source === 'unified_exec_startup' ? 'unifiedExecStartup' : raw.source
    item.exitCode = raw.exit_code
    const duration = readRecord(raw.duration)
    if (
      typeof duration.secs === 'number' &&
      typeof duration.nanos === 'number' &&
      duration.secs >= 0 &&
      duration.nanos >= 0 &&
      duration.nanos < 1e9
    ) {
      const ms = duration.secs * 1000 + Math.floor(duration.nanos / 1e6)
      if (Number.isSafeInteger(ms)) {
        item.durationMs = ms
      }
    }
    item.aggregatedOutput = raw.aggregated_output || undefined
    delete item.parsed_cmd
  } else if (type === 'fileChange' && !Array.isArray(raw.changes)) {
    const changes = readRecord(raw.changes)
    const paths = yield* sortTranscriptWork(Object.keys(changes), (a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    const projected: Record<string, unknown>[] = []
    for (const path of paths) {
      yield 1
      const change = readRecord(changes[path])
      const diff = change.unified_diff ?? change.content ?? ''
      projected.push({
        path,
        kind: {
          type: change.type,
          ...(change.move_path == null ? {} : { movePath: change.move_path })
        },
        diff: change.move_path ? `${String(diff)}\n\nMoved to: ${String(change.move_path)}` : diff
      })
    }
    item.changes = projected
    item.status = item.status ?? 'inProgress'
  } else if (type === 'userMessage' && Array.isArray(raw.content)) {
    const content: unknown[] = []
    for (const value of raw.content) {
      yield 1
      const part = readRecord(value)
      if (['image', 'Image', 'input_image'].includes(String(part.type))) {
        content.push({ ...part, type: 'image', url: part.image_url ?? part.url })
        continue
      }
      content.push(
        ['local_image', 'LocalImage'].includes(String(part.type))
          ? { ...part, type: 'localImage' }
          : value
      )
    }
    item.content = content
  } else if (type === 'agentMessage' && Array.isArray(raw.content) && raw.text === undefined) {
    const parts: string[] = []
    for (const part of raw.content) {
      yield 1
      parts.push(readString(readRecord(part), 'text') ?? '')
    }
    item.text = parts.join('')
  } else if (type === 'reasoning') {
    item.summary = raw.summary_text ?? raw.summary
    item.content = raw.raw_content ?? raw.content
  }
  return item
}
