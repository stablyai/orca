import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime } from './session-scanner-types'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject,
  tokenTotal
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// Why: gjc persists conversations as append-only JSONL under
// ~/.gjc/agent/sessions/<encoded-cwd>/<uuidv7>.jsonl. The first line is a
// `{type:"session"}` header carrying id/cwd/title/timestamp; subsequent lines
// are `{type:"message", message:{role, content, usage?, model?}}` entries.
export async function parseGjcSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseGjcSessionLines({ file, lines, platform })
}

export async function parseGjcSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseGjcSessionLines({ file, lines: content.split(/\r?\n/), platform, options })
}

function previewRole(role: unknown): AiVaultSessionPreviewMessage['role'] {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return role
    // Why: gjc developer messages are injected system context; surface them as
    // 'system' so the preview role stays inside the shared union.
    case 'developer':
      return 'system'
    default:
      return 'unknown'
  }
}

async function parseGjcSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'gjc',
    file: args.file,
    sessionId: sessionIdFromFileName(args.file.path)
  })
  let headerTitle: string | null = null
  let firstUserTitle: string | null = null

  for await (const line of args.lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    updateTimeline(accumulator, extractString(record.timestamp))

    if (record.type === 'session') {
      const id = extractString(record.id)
      if (id) {
        accumulator.sessionId = id
      }
      const cwd = extractString(record.cwd)
      if (cwd) {
        accumulator.cwd = cwd
      }
      const title = normalizeTitleText(extractString(record.title) ?? '')
      if (title) {
        // A user-set title wins outright; an auto-generated title only seeds the
        // fallback so an explicit later custom-title entry can still override it.
        if (record.titleSource === 'user') {
          accumulator.title = title
        } else {
          headerTitle = title
        }
      }
      continue
    }

    if (record.type === 'model_change') {
      const model = extractString(record.model)
      if (model) {
        accumulator.model = model
      }
      continue
    }

    if (record.type !== 'message') {
      continue
    }

    const message = asRecord(record.message)
    if (!message) {
      continue
    }
    const role = message.role
    accumulator.messageCount++
    addPreviewContent(accumulator, previewRole(role), message.content, record.timestamp)
    if (role === 'assistant') {
      const model = extractString(message.model)
      if (model) {
        accumulator.model = model
      }
      accumulator.totalTokens += tokenTotal(message.usage)
    } else if (role === 'user' && !firstUserTitle) {
      firstUserTitle = normalizeTitleText(previewFirstText(message.content) ?? '')
    }
  }

  accumulator.fallbackTitle = headerTitle ?? firstUserTitle
  return finalizeSession(accumulator, args.platform, args.options)
}

// Why: user messages carry content as a string or Anthropic-style text blocks;
// pull the first textual fragment for the last-resort title without importing
// the full preview normalizer twice.
function previewFirstText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  for (const item of content) {
    const text = extractString(asRecord(item)?.text)
    if (text) {
      return text
    }
  }
  return null
}
