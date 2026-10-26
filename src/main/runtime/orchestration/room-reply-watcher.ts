/**
 * Watches turn completions on the structured-agent-session host; when a turn ends on a
 * session that belongs to a room member, the member's latest assistant text is lifted
 * out of the journal and posted into the room through `postRoomReply`, then any
 * `@`-calls it made are run as the next round.
 *
 * Lives as long as the host: the watcher installs itself the first time a room send
 * needs it and never detaches, so a room answers even while no client is looking.
 */

import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-turn-completion-wire'
import type { OrchestrationDb } from './db'
import type { RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'
import { postRoomReply, runRoomRound, sendRoomTurn, type RoomRoundDeps } from './room-round'
import { assistantTextForTurn, turnStartedByRoom } from './room-reply-turn-text'
import {
  parseAdminToolCalls,
  runAdminToolCalls,
  stripToolBlocks,
  type AdminToolRuntime
} from './room-admin-tools'
import { spawnRoomBot } from './room-bot-spawn'
import type { OrcaRuntimeService } from '../orca-runtime'

const WATCHER_ID = 'orchestration-room-replies'
/** Cross-turn hop cap per user message: @-call chains and report-backs share it. */
const ROOM_WATCH_HOP_MAX = 12

const watched = new WeakSet<StructuredAgentSessionHost>()
/** Rooms currently running a round; keyed so a reply mid-flight does not double-run. */
const roomsInFlight = new Set<string>()
const roomWatchBudgets = new Map<string, { rootSeq: number; hops: number }>()

type WatcherDeps = {
  db: OrchestrationDb
  host: StructuredAgentSessionHost
  /** Without a runtime the watcher still posts replies, but admin tool calls stay inert. */
  runtime?: OrcaRuntimeService
}

function memberForSession(db: OrchestrationDb, sessionId: string): RoomMemberRow[] {
  if (!isOrcaSessionId(sessionId)) {
    return []
  }
  const address = formatOrcaSessionAddress(sessionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
  return db.db
    .prepare(
      `SELECT room_id, member_id, name, is_admin, seen_seq, session_id, status,
            status_updated_at, created_at
       FROM room_members WHERE member_id = ? OR session_id = ?`
    )
    .all(address, address) as RoomMemberRow[]
}

function setAttentionStatus(db: OrchestrationDb, sessionId: string, waiting: boolean): void {
  for (const memberRow of memberForSession(db, sessionId)) {
    if (waiting) {
      db.setRoomMemberStatus(memberRow.room_id, memberRow.member_id, 'waiting')
      continue
    }
    if (memberRow.status === 'waiting') {
      db.setRoomMemberStatus(memberRow.room_id, memberRow.member_id, 'idle')
    }
  }
}

/** Start a fresh hop budget for the room's next user-triggered exchange. */
export function resetRoomWatchBudget(db: OrchestrationDb, roomId: string): void {
  const room = db.getRoom(roomId)
  if (room) {
    roomWatchBudgets.set(roomId, { rootSeq: room.seq, hops: 0 })
  }
}

function spendWatchHop(roomId: string): boolean {
  let budget = roomWatchBudgets.get(roomId)
  if (!budget) {
    budget = { rootSeq: 0, hops: 0 }
    roomWatchBudgets.set(roomId, budget)
  }
  budget.hops += 1
  return budget.hops <= ROOM_WATCH_HOP_MAX
}

function roundDeps(deps: WatcherDeps, room: RoomWithMembers): RoomRoundDeps {
  return {
    db: deps.db,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFenceFor: () => 0,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }
}

/** In admin mode, a non-admin reply is routed to the admin so it can respond to the
 *  user's message with what the group just said — the report-back DeepSeek-Bot does
 *  after a round. Skipped when the speaker IS the admin or no admin is set. */
async function reportToAdmin(
  room: RoomWithMembers,
  speaker: RoomMemberRow,
  replyText: string,
  deps: WatcherDeps
): Promise<void> {
  if (room.mode !== 'admin' || !room.admin_member_id) {
    return
  }
  if (speaker.member_id === room.admin_member_id) {
    return
  }
  const admin = room.members.find((m) => m.member_id === room.admin_member_id)
  if (!admin) {
    return
  }
  const prompt = [
    `${speaker.name} just replied in the room "${room.name}":`,
    '',
    replyText,
    '',
    "As this room's admin, decide whether the group needs a response. If you have a summary or a follow-up for the user, post it now with no name prefix. Reply [PASS] to stay silent."
  ].join('\n')
  const sent = await sendRoomTurn({
    member: admin,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFence: 0,
    prompt,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }).catch(() => {
    // A failed report-back must not break the watcher for the rest of the roster.
  })
  if (sent && (sent.kind === 'sent' || sent.kind === 'queued')) {
    deps.db.setRoomMemberStatus(room.id, admin.member_id, 'working')
  }
}

async function handleCompletion(
  completion: Extract<AgentSessionTurnCompletionEvent, { type: 'completion' }>['completion'],
  deps: WatcherDeps
) {
  const memberRows = memberForSession(deps.db, completion.sessionId)
  if (!memberRows.length) {
    return
  }
  setAttentionStatus(deps.db, completion.sessionId, false)
  const failed = completion.outcome === 'failure'
  const snapshot = await deps.host.journalSnapshot(completion.sessionId)
  if (!turnStartedByRoom(snapshot.items, completion.turnId)) {
    return
  }
  const text = assistantTextForTurn(snapshot.items, completion.turnId)
  for (const memberRow of memberRows) {
    const room = deps.db.getRoom(memberRow.room_id)
    if (!room) {
      continue
    }
    try {
      deps.db.setRoomMemberStatus(room.id, memberRow.member_id, failed ? 'failed' : 'idle')
      if (!spendWatchHop(room.id)) {
        deps.db.appendRoomLine(room.id, {
          who: 'Orca',
          text: '[Orca: turn budget spent; send a new message to continue.]'
        })
        continue
      }
      if (!text) {
        if (failed) {
          deps.db.appendRoomLine(room.id, {
            who: memberRow.name,
            memberId: memberRow.member_id,
            text: 'The bot turn failed before it produced a reply.',
            kind: 'failed'
          })
        }
        continue
      }
      const toolCalls = memberRow.is_admin === 1 ? parseAdminToolCalls(text) : []
      const postText = toolCalls.length ? stripToolBlocks(text) : text
      const result = postText
        ? await postRoomReply(room, memberRow.member_id, postText, roundDeps(deps, room))
        : { seq: room.seq, followUps: [], passed: false }
      const adminCalled = result.followUps.some(
        (m) => m.member_id === room.admin_member_id && m.member_id !== memberRow.member_id
      )
      if (!result.passed && !adminCalled) {
        await reportToAdmin(room, memberRow, postText || text, deps)
      }
      await runAdminTools(room, memberRow, text, deps)
      if (result.followUps.length && !roomsInFlight.has(room.id)) {
        roomsInFlight.add(room.id)
        try {
          const fresh = deps.db.getRoom(room.id)
          if (fresh) {
            await runRoomRound(
              fresh,
              {
                text: `[Orca: ${result.followUps.map((m) => `@${m.name}`).join(', ')} called to speak]`,
                who: 'Orca'
              },
              roundDeps(deps, fresh)
            )
          }
        } finally {
          roomsInFlight.delete(room.id)
        }
      }
    } catch {
      // A failed reply must not poison the watcher for other rooms; the member's
      // failed status remains visible in the room roster/state.
    }
  }
}

async function handlePrompt(
  completion: Extract<AgentSessionTurnCompletionEvent, { type: 'prompt' }>['prompt'],
  deps: WatcherDeps
): Promise<void> {
  setAttentionStatus(deps.db, completion.sessionId, true)
}

/** Execute an admin member's group tool calls, show the outcome in the room,
 *  and hand the results back to the admin as its next turn. */
async function runAdminTools(
  room: RoomWithMembers,
  speaker: RoomMemberRow,
  replyText: string,
  deps: WatcherDeps
): Promise<void> {
  if (!deps.runtime || speaker.is_admin !== 1) {
    return
  }
  if (!parseAdminToolCalls(replyText).length) {
    return
  }
  const runtime = deps.runtime
  const toolRt: AdminToolRuntime = {
    db: deps.db,
    caller: speaker,
    defaultWorktree: room.worktree,
    spawnBot: async (args) => {
      const target = deps.db.getRoom(args.roomId)
      if (!target) {
        throw new Error('The room is not here.')
      }
      return spawnRoomBot({
        runtime,
        db: deps.db,
        room: target,
        name: args.name,
        agent: args.agent,
        worktree: args.worktree,
        instructions: args.instructions,
        isAdmin: args.isAdmin,
        model: args.model,
        effort: args.effort
      })
    },
    readLog: (roomId, limit) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The SELECT columns match the room schema created by migrations v44–46.
      deps.db.db
        .prepare(`SELECT who, text FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(roomId, limit)
        .toReversed() as { who: string; text: string }[],
    sendToRoom: async (roomId, text) => {
      const target = deps.db.getRoom(roomId)
      if (!target) {
        throw new Error('The room is not here.')
      }
      await runRoomRound(
        target,
        { text, who: 'Orca' },
        roundDeps({ db: deps.db, host: deps.host }, target)
      )
    }
  }
  const { results } = await runAdminToolCalls(toolRt, replyText)
  if (!results.length) {
    return
  }
  const summary = results.map((line) => `- ${line}`).join('\n')
  deps.db.appendRoomLine(room.id, { who: 'Orca', text: summary })
  const admin = deps.db.getRoom(room.id)?.members.find((m) => m.member_id === speaker.member_id)
  if (!admin) {
    return
  }
  const sent = await sendRoomTurn({
    member: admin,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFence: 0,
    prompt: `Your group tools just ran:\n${summary}\n\nTell the user what happened briefly, or reply [PASS] if your room message already says it.`,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }).catch(() => {
    // Tool results are already in the room; a missed follow-up is harmless.
  })
  if (sent && (sent.kind === 'sent' || sent.kind === 'queued')) {
    deps.db.setRoomMemberStatus(room.id, admin.member_id, 'working')
  }
}
/** Idempotent. First call per host wires the subscription; later calls no-op. */
export function ensureRoomReplyWatcher(deps: WatcherDeps): void {
  if (watched.has(deps.host)) {
    return
  }
  watched.add(deps.host)
  deps.host.subscribeTurnCompletions({
    id: WATCHER_ID,
    includePrompts: true,
    onState: (state) => {
      setAttentionStatus(deps.db, state.sessionId, state.pendingPromptIds.length > 0)
    },
    emit: (event) => {
      if (event.type === 'completion') {
        void handleCompletion(event.completion, deps)
      }
      if (event.type === 'prompt') {
        void handlePrompt(event.prompt, deps)
      }
    }
  })
}

/** Hook for callers that already hold the runtime; reads the installed host itself. */
export function ensureRoomReplyWatcherForCurrentHost(
  db: OrchestrationDb,
  runtime?: OrcaRuntimeService
): void {
  const host = getStructuredAgentSessionHost()
  if (host) {
    ensureRoomReplyWatcher({ db, host, runtime })
  }
}
