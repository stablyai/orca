import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionToolCallBlock } from '../../../shared/agent-session/view/messages/structured-agent-session-tool-call-block'
import { nativeChatToolRunViewedImages } from '../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { markUnclaimedUploadForSweep } from '../../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { AgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { JournalWriterCommand } from '../../native-chat/agent-session-journal/journal-writer-command'
import type { JournalWriterPublication } from '../../native-chat/agent-session-journal/journal-writer-changes'
import { claimJournalSqlItemInputs } from '../../native-chat/agent-session-journal/journal-sql-item-claims'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
)

let stateDirectory: string
let store: AgentSessionAttachmentStore

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-acp-tool-images-'))
  store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(stateDirectory), {
    hasSession: () => true
  })
  setAgentSessionAttachmentStore(store)
})

afterEach(async () => {
  setAgentSessionAttachmentStore(null)
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

function toolBody(
  lane: AcpTimelineTranslator,
  update: Record<string, unknown>
): AgentJournalToolCallItem {
  const events = lane.notification('session/update', { sessionId: 's', update }, 2)
  expect(events.filter((event) => event.type === 'provider.frame')).toEqual([])
  for (const event of events) {
    if ('body' in event && event.body.kind === 'tool-call') {
      return event.body
    }
  }
  throw new Error('no tool-call event')
}

it('keeps a pathless tool image once, by reference, through journal, wire, preview and sweep', async () => {
  const lane = new AcpTimelineTranslator({ sessionId: 's', dialect: OPENCODE_ACP_DIALECT })
  lane.openPrompt('p', 1)
  const content = [
    {
      type: 'content',
      content: { type: 'image', mimeType: 'IMAGE/PNG', data: PNG.toString('base64') }
    }
  ]
  const running = toolBody(lane, {
    sessionUpdate: 'tool_call',
    toolCallId: 'shot',
    title: 'Screenshot',
    status: 'in_progress',
    content
  })
  const [path] = running.outputImagePaths ?? []
  await store.whenWritten(path!)
  expect(await readFile(path!)).toEqual(PNG)
  toolBody(lane, { sessionUpdate: 'tool_call_update', toolCallId: 'shot', content })
  const completed = toolBody(lane, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'shot',
    status: 'completed'
  })
  expect(completed.outputImagePaths).toEqual([path])
  await store.whenWritten(path!)
  expect(await readdir(store.rootDir)).toHaveLength(1)

  expect(AgentJournalItemBodySchema.parse(JSON.parse(JSON.stringify(completed)))).toEqual(completed)
  expect(
    nativeChatToolRunViewedImages([structuredAgentSessionToolCallBlock(completed, 'item')])
  ).toEqual([{ type: 'image-ref', path }])

  const journal = openTestJournalHostDatabase(stateDirectory)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim step reads only target.sessionId, operation.kind and savedAt
  const command = {
    target: { sessionId: 'session-1', epoch: 'epoch', ownerToken: 'owner' },
    operation: { kind: 'item' },
    savedAt: 1
  } as unknown as JournalWriterCommand
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim step reads only items[].body
  const publication = { items: [{ body: completed }] } as unknown as JournalWriterPublication
  journal.transaction((db) => claimJournalSqlItemInputs(db, stateDirectory, command, publication))
  expect(
    journal.writeAutocommit((db) =>
      markUnclaimedUploadForSweep(db, dirname(path!).split(/[\\/]/).pop()!, 1)
    )
  ).toBe(false)
})

it('leaves a read tool on its file path thumbnail', () => {
  const lane = new AcpTimelineTranslator({ sessionId: 's', dialect: OPENCODE_ACP_DIALECT })
  lane.openPrompt('p', 1)
  const read = toolBody(lane, {
    sessionUpdate: 'tool_call',
    toolCallId: 'read',
    title: 'read',
    kind: 'read',
    status: 'completed',
    rawInput: { filePath: '/images/diagram.png' },
    content: [
      {
        type: 'content',
        content: { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }
      }
    ]
  })
  expect(read.outputImagePaths).toBeUndefined()
  expect(
    nativeChatToolRunViewedImages([structuredAgentSessionToolCallBlock(read, 'item')])
  ).toEqual([{ type: 'image-ref', path: '/images/diagram.png' }])
})
