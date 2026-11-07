import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../db/orchestration-db'
import { SessionLinkStore } from './session-link-store'
import { SessionLinkParticipant } from '../../../../shared/session-link'

const participant = (id: string, role: 'reviewer' | 'implementer') =>
  SessionLinkParticipant.parse({
    sessionId: id,
    conversationId: id,
    role,
    name: id,
    agent: role === 'reviewer' ? 'claude' : 'codex',
    workspaceId: `repo::/work/${id}`,
    directory: `/work/${id}`,
    branch: 'feature',
    task: 'Review slice 1b without spending',
    context: ''
  })

describe('durable session link boundaries', () => {
  let directory: string
  let db: OrchestrationDb
  let store: SessionLinkStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'session-link-'))
    db = new OrchestrationDb(join(directory, 'mail.sqlite'))
    store = new SessionLinkStore(db)
    store.create('link-1', 'Slice 1b', [
      participant('claude_review', 'reviewer'),
      participant('codex_implement', 'implementer')
    ])
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const message = (id: string) => ({
    id,
    linkId: 'link-1',
    actor: 'codex_implement',
    recipient: 'claude_review',
    body: id,
    kind: 'message' as const
  })

  it('survives restart between reservation and provider acknowledgment without minting another send', () => {
    const first = store.append(message('checkpoint-1'))
    store.reserve('link-1', first.id)
    db.close()
    db = new OrchestrationDb(join(directory, 'mail.sqlite'))
    store = new SessionLinkStore(db)
    const restored = store.reserve('link-1', first.id)
    expect(restored?.operationId).toBe(first.operationId)
    expect(restored?.body).toBe('checkpoint-1')
    expect(store.get('link-1').turns).toBe(1)
    expect(db.getUndeliveredUnreadMessages('orca_session_id:claude_review')).toEqual([])
  })

  it('persists owner choices across restart and rejects changed retry choices', () => {
    const input = {
      ...message('owner-question'),
      kind: 'owner-request' as const,
      choices: [
        { label: 'Offline only' },
        { label: 'Approve $0.10', description: 'Same data boundary' }
      ],
      allowOther: false
    }
    store.append(input)
    db.close()
    db = new OrchestrationDb(join(directory, 'mail.sqlite'))
    store = new SessionLinkStore(db)
    expect(store.events('link-1')[0]).toMatchObject({
      choices: input.choices,
      allowOther: false,
      state: 'recorded',
      recipient: null
    })
    expect(store.append(input).choices).toEqual(input.choices)
    expect(() =>
      store.append({ ...input, choices: [{ label: 'Offline only' }, { label: 'Approve $1' }] })
    ).toThrow('different content')
    expect(() => store.append({ ...input, allowOther: true })).toThrow('different content')
    expect(store.events('link-1').filter((event) => event.kind === 'owner-request')).toHaveLength(1)
    expect(db.getUndeliveredUnreadMessages('orca_session_id:claude_review')).toEqual([])
  })

  it('keeps a queued checkpoint on pause and refuses a raced wakeup', () => {
    const event = store.append(message('checkpoint-1'))
    store.control('link-1', 'owner', 'pause-1', 1, 'pause')
    expect(store.reserve('link-1', event.id)).toBeNull()
    expect(store.events('link-1')[0].state).toBe('queued')
    expect(() => store.control('link-1', 'owner', 'resume-stale', 1, 'resume')).toThrow('changed')
    expect(store.get('link-1').state).toBe('paused')
  })

  it('enforces the turn budget and replays owner continuation without granting a second budget', () => {
    for (let i = 0; i < 6; i++) {
      store.reserve('link-1', store.append(message(`checkpoint-${i}`)).id)
    }
    expect(store.reserve('link-1', store.append(message('seventh')).id)).toBeNull()
    const paused = store.get('link-1')
    expect(paused.reason).toBe('turn-limit')
    store.control('link-1', 'owner', 'resume-1', paused.version, 'resume')
    store.reserve('link-1', 'seventh')
    store.control('link-1', 'owner', 'resume-1', paused.version, 'resume')
    expect(store.get('link-1').turns).toBe(1)
  })

  it('rejects changed retry content and foreign checkpoint replies without partial writes', () => {
    store.append(message('checkpoint-1'))
    expect(() => store.append({ ...message('checkpoint-1'), body: 'different' })).toThrow(
      'different'
    )
    expect(() =>
      store.append({ ...message('reply-1'), kind: 'reply', replyTo: 'unknown' })
    ).toThrow('Reply')
    expect(store.get('link-1').messages).toBe(1)
    expect(store.events('link-1')).toHaveLength(1)
    expect(() => store.append({ ...message('long'), body: 'я'.repeat(4097) })).toThrow('8 KiB')
    expect(store.events('link-1')).toHaveLength(1)
  })

  it('pauses repeated traffic and owner decisions without treating an agent as the owner', () => {
    for (let i = 0; i < 3; i++) {
      store.append({ ...message(`repeat-${i}`), body: 'Are you there?' })
    }
    expect(store.get('link-1').reason).toBe('repeated-messages')
    store.append({ ...message('money'), kind: 'owner-request', body: 'Need a paid run' })
    expect(store.get('link-1').reason).toBe('owner-decision')
    expect(store.get('link-1').state).toBe('paused')
  })

  it('keeps history after either participant ends the link and releases the pair for a new link', () => {
    store.append(message('checkpoint-1'))
    expect(() =>
      store.create('link-2', 'Other task', [
        participant('claude_review', 'reviewer'),
        participant('codex_other', 'implementer')
      ])
    ).toThrow('active')
    store.control('link-1', 'codex_implement', 'leave-1', 1, 'end')
    expect(store.events('link-1')[0]).toMatchObject({ state: 'cancelled', body: 'checkpoint-1' })
    expect(store.forSession('claude_review')).toBeNull()
    expect(() => store.append(message('late'))).toThrow('ended')
    expect(
      store.create('link-2', 'Other task', [
        participant('claude_review', 'reviewer'),
        participant('codex_other', 'implementer')
      ]).state
    ).toBe('active')
  })
  it('keeps the link journal intact when ordinary orchestration mail is reset', () => {
    store.append(message('report'))
    db.resetMessages()
    expect(store.events('link-1')[0].body).toBe('report')
    expect(store.append(message('report')).body).toBe('report')
  })

  it('correlates checkpoints and rejects a second outstanding question and duplicate review replies', () => {
    store.append({ ...message('ready'), kind: 'checkpoint' })
    expect(() => store.append({ ...message('next'), kind: 'question' })).toThrow('awaits')
    const reply = {
      id: 'decision',
      linkId: 'link-1',
      actor: 'claude_review',
      recipient: 'codex_implement',
      kind: 'reply' as const,
      replyTo: 'ready',
      body: 'Local checks may continue; owner decides spending.'
    }
    const decision = store.append(reply)
    expect(() => store.append({ ...reply, id: 'duplicate' })).toThrow('already answered')
    expect(() => store.append({ ...message('next'), kind: 'checkpoint' })).toThrow('awaits')
    store.write({ ...decision, state: 'accepted' })
    expect(store.append({ ...message('next'), kind: 'checkpoint' }).id).toBe('next')
    expect(() => store.append({ ...reply, id: 'stale' })).toThrow('already answered')
  })
})
