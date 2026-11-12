import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionAttachmentStoreRoot } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  reduceStructuredAgentSession,
  EMPTY_STRUCTURED_AGENT_SESSION
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { openStream } from './structured-agent-session-rpc.test-fixture'

export function streamState(frames: Awaited<ReturnType<typeof openStream>>) {
  return frames.reduce((state, frame) => {
    if (!frame.ok) {
      throw new Error('subscription failed')
    }
    if (!frame.result) {
      return state
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the installed subscribe dispatcher writes these serialized events.
    const event = frame.result as AgentSessionSubscribeEvent
    return reduceStructuredAgentSession(state, { type: 'event', event })
  }, EMPTY_STRUCTURED_AGENT_SESSION)
}

export async function queuedImageTestBody(
  root: string,
  text = 'original'
): Promise<AgentJournalMessageItem> {
  const dir = join(agentSessionAttachmentStoreRoot(root), '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture image bytes')
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      { type: 'image-ref', path }
    ]
  }
}
