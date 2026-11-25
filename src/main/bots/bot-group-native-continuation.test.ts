import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { routeRemoteGroupMail } from './bot-group-remote-mail-routing'
import { runtimeBotGroups } from './bot-group-runtime'
import { makeTestBot } from './bot.test-fixture'

it.each(['resume', 'stop'] as const)(
  'preserves a committed native continuation and a later inbound post while off: %s',
  async (action) => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-paused-continuation-'))
    const db = new OrchestrationDb(':memory:')
    onTestFinished(async () => {
      setStructuredAgentSessionHost(null)
      db.close()
      await closeTestStores()
      rmSync(folder, { recursive: true, force: true })
    })
    const prefs = createSqliteTestStore(Store, { dataFile: join(folder, 'state.json') })
    const enable = (botsEnabled: boolean) =>
      prefs.updateSettings({ botsEnabled }, { notifyListeners: true })
    enable(true)
    const runtime = new OrcaRuntimeService(prefs)
    runtime.setOrchestrationDb(db)
    onTestFinished(() => runtime.stopOrchestrationFederationRelay())
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    const local = makeTestBot({ id: 'scout', name: 'Scout' })
    vi.spyOn(runtime.bots, 'list').mockReturnValue([local])
    const sessionId = 'bot-group-member-scout'
    const remote = {
      botId: 'atlas',
      name: 'Atlas',
      avatar: null,
      agent: 'claude' as const,
      environmentId: 'atlas-host',
      computer: 'Atlas host',
      joinedAfter: 0,
      chatSessionId: '55555555-5555-4555-8555-555555555555'
    }
    const group: BotGroup = {
      id: 'crew',
      name: 'Crew',
      folder,
      folderWorkspaceId: 'crew',
      hostId: 'local',
      createdAt: 1,
      revision: 1,
      replyMode: { kind: 'mentions' },
      members: [{ botId: local.id, sessionId }],
      remoteMembers: [remote]
    }
    const groups = runtimeBotGroups(runtime)
    groups.store.put(group)
    const address = botGroupRoomMailAddress(group.id)
    const pairing = 'pairing-atlas'
    const { conversation_id: conversationId } = db.openHomePeerMailConversation({
      environmentId: remote.environmentId,
      peerFingerprint: pairing,
      localParty: address,
      localPaneKey: null
    })
    const root = groups.store.append({
      id: 'root',
      groupId: group.id,
      author: { kind: 'owner' },
      text: 'Confirm receipt.',
      createdAt: 1,
      turns: []
    })
    const text = 'Atlas confirmed receipt.'
    const requestId = 'msg_request'
    groups.store.append({
      id: 'handoff',
      groupId: group.id,
      rootRequestId: root.id,
      rootSequence: root.sequence,
      author: { kind: 'bot', id: local.id, name: local.name },
      text: 'Scout asked Atlas',
      createdAt: 2,
      turns: [],
      groupRequest: {
        from: { kind: 'local', botId: local.id, sessionId, name: local.name },
        remoteEdges: [],
        returnAnswer: true
      },
      remoteAsks: [
        {
          ...group.remoteMembers![0],
          requestId,
          conversationId,
          pairing,
          interactive: true,
          state: 'sent',
          reply: { kind: 'answer', text }
        }
      ]
    })
    for (const isPost of [false, true]) {
      const mailId = isPost ? 'msg_followup' : 'msg_answer'
      db.insertPeerMailMessage({
        conversationId,
        remoteParty: `orca_session_id:${remote.chatSessionId}`,
        message: {
          id: mailId,
          from: remote.name,
          to: address,
          subject: 'From Atlas',
          body: isPost ? 'Reference only.' : text,
          threadId: requestId
        }
      })
      groups.store.routes.stageMailRoute(mailId, group.id, requestId, isPost)
    }

    const lookup = Promise.withResolvers<void>()
    const releaseLookup = Promise.withResolvers<void>()
    const admission = Promise.withResolvers<void>()
    const releaseAdmission = Promise.withResolvers<void>()
    const sends: { id: string; text: string }[] = []
    let lookups = 0
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(async () => {
      if (++lookups === 2) {
        lookup.resolve()
        await releaseLookup.promise
      }
      return {
        environmentId: remote.environmentId,
        name: remote.computer,
        peerFingerprint: pairing
      }
    })
    let holdAdmission = action === 'resume'
    const native = {
      deps: { store: { requireWritableRecord: () => ({ lease: { runtimeFence: 1 } }) } },
      journalReads: async () => ({
        operationSent: async (id: string) => sends.some((send) => send.id === id)
      }),
      send: async (_: unknown, input: Parameters<StructuredAgentSessionHost['send']>[1]) => {
        if (holdAdmission) {
          holdAdmission = false
          admission.resolve()
          await releaseAdmission.promise
        }
        await input.beforeRun?.()
        const id = input.envelope.clientOperationId
        const block = input.body.blocks[0]
        sends.push({ id, text: block.type === 'text' ? block.text : '' })
        return { ok: true, value: { clientMessageId: id } }
      },
      cancel: async () => ({ ok: true })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this substitutes only the native send, journal probe and cancel boundary.
    setStructuredAgentSessionHost(native as unknown as StructuredAgentSessionHost)
    try {
      const drain = routeRemoteGroupMail(groups, group.id)
      await lookup.promise
      const continuation = groups.store.message('group-answer:msg_answer')!
      const operationId = continuation.turns[0].operationId
      const context = groups.store.pendingContext(operationId)
      expect(context).not.toBeNull()
      enable(false)
      releaseLookup.resolve()
      await drain
      expect(groups.store.pendingContext(operationId)).toBe(context)
      expect(groups.store.routes.pendingMailRoutes(group.id)).toEqual([
        { mailId: 'msg_followup', requestId, isPost: true }
      ])
      expect(sends).toEqual([])

      if (action === 'stop') {
        await groups.stop(group.id)
        enable(true)
      } else {
        enable(true)
        await admission.promise
        await groups.queues.get(group.id)
        enable(false)
        releaseAdmission.resolve()
        await vi.waitFor(() => expect(groups.deliveries.has(operationId)).toBe(false))
        expect(groups.store.pendingContext(operationId)).toBe(context)
        expect(sends).toEqual([])
        enable(true)
      }
      await groups.queues.get(group.id)
      await vi.waitFor(() => expect(groups.store.pendingContext(operationId)).toBeNull())
      expect(groups.store.routes.pendingMailRoutes(group.id)).toEqual([])
      expect(sends).toEqual(
        action === 'stop' ? [] : [{ id: operationId, text: expect.stringContaining(text) }]
      )
      expect(groups.store.message('group-answer:msg_answer')?.text).toBe(text)
      if (action === 'stop') {
        expect(groups.store.message('group-post:msg_followup')).toBeNull()
      } else {
        expect(groups.store.message('group-post:msg_followup')?.text).toBe('Reference only.')
      }
    } finally {
      releaseLookup.resolve()
      releaseAdmission.resolve()
    }
  }
)
