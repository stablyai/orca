import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionAttachmentUploadIdOfPath } from '../../../../shared/agent-session/agent-session-attachments'
import { botItemEventId } from '../../../../shared/bots/bot-items'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotItemsStore } from '../../../bots/bot-items-store'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  claimAgentSessionAttachmentsInTransaction,
  finishUploadSweep,
  listUploadsBeingSwept,
  markUnclaimedUploadForSweep,
  pruneAgentSessionAttachmentClaims
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { sweepAgentSessionAttachments } from '../../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { applyJournalWriterEffect } from '../../../native-chat/agent-session-journal/journal-writer-effects'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RpcContext } from '../core'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-sessions/attachments/structured-agent-session-attachments'
import { BOT_ITEMS_OWNER_METHODS } from './bots-items-owner-methods'
import { botItemMailId, sendBotItemMail } from './bots-items-mail'

const ORIGINAL = 'eae99fff-0cb1-49a9-877d-b90ceb29375a'
const HOME = '54889ba4-947c-4531-8221-8ab6aea262a9'
const ANOTHER_BOT_HOME = '9745ea23-ea63-43d8-9a38-7ac457e021b7'
const AGENT = { kind: 'bot', botId: 'repair-bot', chatId: ORIGINAL } as const
const NOW = 1_800_000_000_000

it('claims an item answer for the chat it actually mails and replays the same answer after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-item-answer-'))
  const itemDb = join(dir, 'items.sqlite')
  let items = BotItemsStore.open(itemDb)
  const journal = openTestJournalHostDatabase(dir)
  const mail = new OrchestrationDb(':memory:')
  const bot = {
    id: AGENT.botId,
    folderWorkspaceId: 'bot-home',
    agent: 'claude',
    chatSessionId: ORIGINAL
  }
  const chats = new Map(
    [ORIGINAL, HOME, ANOTHER_BOT_HOME].map((sessionId) => [
      sessionId,
      agentSessionConversationView(
        agentSessionRecordFixture({
          sessionId,
          location: {
            workspaceId: folderWorkspaceKey(
              sessionId === ANOTHER_BOT_HOME ? 'other-bot' : bot.folderWorkspaceId
            )
          }
        })
      )
    ])
  )
  const { uid } = items.add(
    {
      ownerBotId: bot.id,
      chatId: ORIGINAL,
      source: { kind: 'home', title: null },
      title: 'Verify the screenshot',
      status: 'working',
      links: []
    },
    AGENT
  )
  items.set(
    uid,
    {
      status: 'needs_you',
      ask: {
        questions: [
          { prompt: 'Is the indicator green?', options: [{ label: 'Yes' }, { label: 'No' }] }
        ]
      }
    },
    AGENT
  )
  const eventId = botItemEventId(items.get(uid)!.questionEvent!)
  const attachments = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(dir), {
    hasSession: (sessionId) => chats.has(sessionId)
  })
  let replaceDuringClaim = false
  const retired = Promise.withResolvers<void>()
  const successorReady = Promise.withResolvers<void>()
  let reset: Promise<void> | undefined
  const claimedFor: string[] = []
  setAgentSessionAttachmentStore(attachments, async (sessionId, body) => {
    claimedFor.push(sessionId)
    journal.writeAutocommit((db) =>
      claimAgentSessionAttachmentsInTransaction(db, {
        stateDirectory: dir,
        sessionId,
        body,
        required: true,
        now: NOW
      })
    )
    if (replaceDuringClaim && sessionId === ORIGINAL) {
      reset = runtimeBotChats(context.runtime).withChat(bot.id, async () => {
        chats.delete(ORIGINAL)
        retired.resolve()
        await successorReady.promise
        bot.chatSessionId = HOME
      })
      await retired.promise
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the read-side host seam and note destination are used.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getConversation: (id: string) => chats.get(id) ?? null,
        listConversations: () => [...chats.values()],
        isSessionTabRetired: () => false
      }
    },
    captureAgentStartDestination: () => null
  } as unknown as StructuredAgentSessionHost)

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods exercise these runtime ports against real item, attachment and mail stores.
  const context = {
    caller: { kind: 'paired-device', deviceId: 'owner-phone' },
    pairedDeviceId: 'owner-phone',
    runtime: {
      getOrchestrationDb: () => mail,
      ensureStructuredAgentSessionHost: async () => {},
      publishStructuredAgentSessionTab: async () => {},
      notifyMessageArrived: () => {},
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null },
      bots: { list: () => [bot], assertEnabled: () => {} },
      botItems: {
        store: () => items,
        openedStore: () => items,
        changed: () => {},
        sendOwedMail: async () => {}
      }
    }
  } as unknown as RpcContext
  const upload = STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS.find(
    (method) => method.name === 'agentSessionAttachment.uploadStart'
  )!
  const comment = BOT_ITEMS_OWNER_METHODS.find(
    (method) => method.name === 'bots.items.owner.comment'
  )!
  try {
    const file = upload.params.parse({ item: uid, name: 'proof.png', byteLength: 4 })
    await expect(
      upload.handler(file, {
        ...context,
        caller: { kind: 'paired-device', deviceId: 'bot-cli', agent: true }
      })
    ).rejects.toThrow('Only your owner')
    const { uploadId } = await upload.handler(file, context)
    await expect(
      attachments.appendChunk({
        callerKey: 'other-device',
        uploadId,
        offset: 0,
        contentBase64: 'dGVzdA=='
      })
    ).rejects.toThrow('Attachment upload was not found')
    await attachments.appendChunk({
      callerKey: 'owner-phone',
      uploadId,
      offset: 0,
      contentBase64: 'dGVzdA=='
    })
    const { path } = await attachments.commitUpload({ callerKey: 'owner-phone', uploadId })
    const answer = {
      item: uid,
      text: 'Yes',
      images: [path],
      questionId: eventId,
      requestId: 'answer-receipt'
    }
    const accepted = await comment.handler(answer, context)
    expect(items.get(uid)).toMatchObject({
      status: 'working',
      questionEvent: null,
      chatId: ORIGINAL
    })
    items.dispose()
    items = BotItemsStore.open(itemDb)

    let retentionReads = 0
    const sweep = () =>
      sweepAgentSessionAttachments(
        attachments,
        {
          listBeingSwept: () => listUploadsBeingSwept(journal.db),
          markForSweep: (id, now) =>
            journal.writeAutocommit((db) => markUnclaimedUploadForSweep(db, id, now)),
          finishSweep: (id) => journal.writeAutocommit((db) => finishUploadSweep(db, id)),
          pruneClaims: () => {
            journal.writeAutocommit((db) =>
              pruneAgentSessionAttachmentClaims(db, {
                root: attachments.rootDir,
                recordedSessionIds: chats
              })
            )
          },
          retention: {
            isUnclaimed: (uploadId) =>
              applyJournalWriterEffect(journal.db, dir, {
                kind: 'sweep',
                operation: { kind: 'unclaimed', uploadId }
              }) === true,
            uploads: async () => {
              retentionReads++
              return new Set(items.owedCommentAttachmentUploads(attachments.rootDir))
            }
          }
        },
        NOW
      )
    await utimes(dirname(path), new Date(0), new Date(0))
    replaceDuringClaim = true
    const [owed] = items.owedMail(0).mails
    expect(owed).toBeDefined()
    const sending = sendBotItemMail(context.runtime, owed!)
    try {
      await Promise.race([
        retired.promise,
        sending.then(() => {
          throw new Error('Mail finished before the Home replacement')
        })
      ])
      await sweep()
      expect(retentionReads).toBe(0)
      await sweep()
      expect(retentionReads).toBe(1)
    } finally {
      successorReady.resolve()
      await Promise.allSettled([sending, reset])
    }
    expect(await sending).toBe(true)
    await reset
    expect(await sendBotItemMail(context.runtime, owed!)).toBe(true)
    const sent = mail.getMessageById(botItemMailId(owed!.id))!
    expect(sent.to_handle).toBe(`orca_session_id:${HOME}`)
    expect(JSON.parse(sent.payload!)).toMatchObject({ images: [path] })
    expect(await readFile(path, 'utf8')).toBe('test')
    expect(
      journal.db
        .prepare('SELECT session_id FROM agent_session_attachment_claims ORDER BY session_id')
        .all()
    ).toEqual([{ session_id: HOME }])
    items.markMailSent(owed!.changes.map(({ event }) => event.id))
    expect(items.owedCommentAttachmentUploads(attachments.rootDir)).toEqual([])

    await rm(path)
    await expect(comment.handler(answer, context)).resolves.toEqual(accepted)
    expect(
      items
        .events(uid, 0, 30)
        .filter((event) => event.actor.kind === 'owner' && event.kind === 'commented')
    ).toHaveLength(1)

    items.set(
      uid,
      {
        status: 'needs_you',
        ask: {
          questions: [
            { prompt: 'Is the label visible?', options: [{ label: 'Yes' }, { label: 'No' }] }
          ]
        }
      },
      AGENT
    )
    const staged = await upload.handler(file, context)
    await attachments.appendChunk({
      callerKey: 'owner-phone',
      uploadId: staged.uploadId,
      offset: 0,
      contentBase64: 'dGVzdA=='
    })
    const next = await attachments.commitUpload({
      callerKey: 'owner-phone',
      uploadId: staged.uploadId
    })
    claimedFor.length = 0
    await comment.handler(
      {
        ...answer,
        requestId: 'another-answer',
        questionId: botItemEventId(items.get(uid)!.questionEvent!),
        images: [next.path]
      },
      context
    )
    expect(items.get(uid)).toMatchObject({ status: 'working', questionEvent: null })
    const [nextMail] = items.owedMail(0).mails
    expect(await sendBotItemMail(context.runtime, nextMail!)).toBe(true)
    expect(mail.getMessageById(botItemMailId(nextMail!.id))?.to_handle).toBe(
      `orca_session_id:${HOME}`
    )
    // Delivery to the chat admission just claimed for doesn't claim the same uploads again.
    expect(claimedFor).toEqual([HOME])
    expect(await readFile(next.path, 'utf8')).toBe('test')

    items.markMailSent(nextMail!.changes.map(({ event }) => event.id))
    const surviving = await attachments.storeFile('surviving.png', Buffer.from('kept'))
    items.ownerComment(
      uid,
      'Use [Image #1]. [Image #2] is the rejected design.',
      { kind: 'owner' },
      [
        { path, name: 'proof.png', bytes: 4 },
        { path: surviving, name: 'surviving.png', bytes: 4 }
      ]
    )
    const [legacy] = items.owedMail(0).mails
    expect(await sendBotItemMail(context.runtime, legacy!)).toBe(true)
    const delivered = mail.getMessageById(botItemMailId(legacy!.id))!
    expect(JSON.parse(delivered.payload!)).toMatchObject({ images: [surviving] })
    expect(delivered.body).toContain(
      'Use [Orca: image expired]. [Image #1] is the rejected design.'
    )
    expect(delivered.body).toContain('attachments expired before delivery')
    expect(
      journal.db
        .prepare('SELECT session_id FROM agent_session_attachment_claims WHERE upload_id = ?')
        .get(agentSessionAttachmentUploadIdOfPath(surviving)!)
    ).toEqual({ session_id: HOME })
  } finally {
    setAgentSessionAttachmentStore(null)
    setStructuredAgentSessionHost(null)
    items.dispose()
    mail.close()
    await closeTestJournalHostDatabases()
    await rm(dir, { recursive: true, force: true })
  }
})
