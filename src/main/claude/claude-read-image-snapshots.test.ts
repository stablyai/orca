import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-read-snapshots-'))
  setAgentSessionAttachmentStore(
    new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'), {
      hasSession: () => true
    })
  )
})

afterEach(async () => {
  setAgentSessionAttachmentStore(null)
  await rm(root, { recursive: true, force: true })
})

function frame(type: 'assistant' | 'user', uuid: string, content: unknown[]) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: type, content }
    }
  }
}

/** The result row's snapshot paths for a Claude Read of a PNG, whose result carries base64. */
function readImageSnapshots(id: string): string[] {
  const bodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => bodies.push(body),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink })
  const filePath = join(root, 'target', 'select-check', 'shot.png')
  translator.handle(
    frame('assistant', `${id}-call`, [
      { type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }
    ])
  )
  translator.handle(
    frame('user', `${id}-result`, [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') }
          }
        ]
      }
    ])
  )
  const result = bodies.at(-1)
  return result?.kind === 'tool-call' ? (result.resultImagePaths ?? []) : []
}

describe('Claude Read image snapshots', () => {
  it('stores the bytes the agent saw, so the thumbnail survives the source file', async () => {
    const [path] = readImageSnapshots('toolu_1')
    expect(path).toMatch(/agent-session-attachments[\\/][0-9a-f-]{36}[\\/]shot\.png$/)
    expect(await readFile(path!)).toEqual(PNG)
  })

  it('reuses one copy when the same image is read again or replayed', () => {
    const first = readImageSnapshots('toolu_2')
    expect(first).toHaveLength(1)
    expect(readImageSnapshots('toolu_3')).toEqual(first)
  })
})
