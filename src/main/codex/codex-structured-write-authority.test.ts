import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  CodexStructuredWriteAuthority,
  digestRequest,
  type CodexStructuredWriteReceipt
} from './codex-structured-write-authority'

const SESSION = 'session-1'
const THREAD = 'thread-1'
const TURN = 'turn-1'
const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'replace the selected file' }]
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function linkedWorktree(): { root: string; outside: string } {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-structured-write-'))
  roots.push(fixture)
  const root = join(fixture, 'worktree')
  const gitDir = join(fixture, 'canonical.git', 'worktrees', 'bounded')
  const outside = join(fixture, 'outside.txt')
  mkdirSync(root, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(root, '.git')}\n`)
  return { root: realpathSync(root), outside }
}

function item(path: string, id = 'item-1', turnId = TURN): Record<string, unknown> {
  return {
    threadId: THREAD,
    turnId,
    item: {
      type: 'fileChange',
      id,
      status: 'inProgress',
      changes: [{ path, diff: '@@ -1 +1 @@', kind: { type: 'update' } }]
    }
  }
}

function approval(id = 'item-1', turnId = TURN): Record<string, unknown> {
  return { itemId: id, threadId: THREAD, turnId, startedAtMs: 1 }
}

function authority(input: {
  receipts?: CodexStructuredWriteReceipt[]
  authorize?: boolean
}): CodexStructuredWriteAuthority {
  let handle = 0
  return new CodexStructuredWriteAuthority(
    {
      authorizeTurn: ({ writableRoot }) =>
        input.authorize === false
          ? null
          : { requestReceiptId: 'host-request-1', writableRoot, capabilityHandle: 'host-handle-1' },
      consumeLease: () => {},
      onReceipt: (receipt) => input.receipts?.push(receipt)
    },
    () => 1_700_000_000_000,
    () => `opaque-${++handle}`
  )
}

async function issue(
  gate: CodexStructuredWriteAuthority,
  root: string,
  turnId = TURN
): Promise<void> {
  await gate.bindSession(SESSION, root)
  const turnEpoch = await gate.openTurn({
    sessionId: SESSION,
    clientMessageId: 'client-1',
    body: BODY,
    fence: 7
  })
  if (turnEpoch !== null) {
    gate.bindTurn(SESSION, THREAD, turnId, turnEpoch)
  }
}

describe('CodexStructuredWriteAuthority', () => {
  it('retires the bound mutation epoch when Codex completes that turn', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    expect(gate.activeTurn(SESSION)).toEqual({ threadId: THREAD, turnId: TURN })

    gate.observeNotification(SESSION, 'turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'completed' }
    })

    expect(gate.activeTurn(SESSION)).toBeNull()
  })

  it('admits one file change and emits a bounded before/after receipt', async () => {
    const fixture = linkedWorktree()
    const target = join(fixture.root, 'source.txt')
    writeFileSync(target, 'before\n')
    const receipts: CodexStructuredWriteReceipt[] = []
    const gate = authority({ receipts })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('source.txt'))

    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/commandExecution/requestApproval',
        approval('command-1')
      )
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/permissions/requestApproval',
        approval('permissions-1')
      )
    ).resolves.toEqual({ handled: true, result: { permissions: {}, scope: 'turn' } })
    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })

    writeFileSync(target, 'after\n')
    gate.observeNotification(SESSION, 'item/completed', {
      ...item('source.txt'),
      item: { ...(item('source.txt').item as object), status: 'completed' }
    })
    await expect.poll(() => receipts.length).toBe(1)

    expect(receipts[0]).toMatchObject({
      protocolVersion: 1,
      requestReceiptId: 'host-request-1',
      effectDomain: 'local_structured_write',
      sessionId: SESSION,
      turnEpoch: 1,
      fence: 7,
      clientMessageId: 'client-1',
      threadId: THREAD,
      turnId: TURN,
      requestDigest: digestRequest(BODY),
      toolUseId: 'item-1',
      changePlanDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      worktreeRoot: fixture.root,
      outcome: 'completed',
      completedAtMs: 1_700_000_000_000
    })
    expect(receipts[0].capabilityHandleDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(receipts[0].before).toEqual([
      { path: 'source.txt', exists: true, sha256: expect.any(String), bytes: 7 }
    ])
    expect(receipts[0].after).toEqual([
      { path: 'source.txt', exists: true, sha256: expect.any(String), bytes: 6 }
    ])
    expect(receipts[0].before[0].sha256).not.toBe(receipts[0].after[0].sha256)
    expect(readFileSync(target, 'utf8')).toBe('after\n')

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('keeps an admitted change when item started is replayed before completion', async () => {
    const fixture = linkedWorktree()
    const target = join(fixture.root, 'source.txt')
    writeFileSync(target, 'before\n')
    const receipts: CodexStructuredWriteReceipt[] = []
    const gate = authority({ receipts })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('source.txt'))
    await gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())

    gate.observeNotification(SESSION, 'item/started', item('source.txt'))
    writeFileSync(target, 'after\n')
    gate.observeNotification(SESSION, 'item/completed', {
      ...item('source.txt'),
      item: { ...(item('source.txt').item as object), status: 'completed' }
    })
    await gate.flushReceipts()

    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ toolUseId: 'item-1', outcome: 'completed' })
  })

  it('revokes admission when the same item id is reused for another change plan', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('first.txt'))
    gate.observeNotification(SESSION, 'item/started', item('second.txt'))

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
    expect(gate.activeTurn(SESSION)).toBeNull()
  })

  it('atomically accepts only one of two concurrent approvals', async () => {
    const fixture = linkedWorktree()
    const consumeLease = vi.fn(async () => {})
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn: ({ writableRoot }) => ({
        requestReceiptId: 'host-request-1',
        writableRoot,
        capabilityHandle: 'host-handle-1'
      }),
      consumeLease,
      onReceipt: () => {}
    })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('source.txt'))

    const decisions = await Promise.all([
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval()),
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ])

    expect(decisions).toEqual([
      { handled: true, result: { decision: 'accept' } },
      { handled: true, result: { decision: 'decline' } }
    ])
    expect(consumeLease).toHaveBeenCalledOnce()
  })

  it('fails an admitted receipt when its item id is replayed with another plan', async () => {
    const fixture = linkedWorktree()
    const receipts: CodexStructuredWriteReceipt[] = []
    const gate = authority({ receipts })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('first.txt'))
    await gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())

    gate.observeNotification(SESSION, 'item/started', item('second.txt'))
    await gate.flushReceipts()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ toolUseId: 'item-1', outcome: 'failed' })

    gate.observeNotification(SESSION, 'item/completed', {
      ...item('first.txt'),
      item: { ...(item('first.txt').item as object), status: 'completed' }
    })
    await gate.flushReceipts()
    expect(receipts).toHaveLength(1)
  })

  it('revokes the old lease when a new trusted user turn starts', async () => {
    const fixture = linkedWorktree()
    writeFileSync(join(fixture.root, 'source.txt'), 'before\n')
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('source.txt'))

    const turnEpoch = await gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: { ...BODY, blocks: [{ type: 'text', text: 'status?' }] },
      fence: 7
    })
    expect(turnEpoch).toBe(2)
    gate.bindTurn(SESSION, THREAD, 'turn-2', turnEpoch as number)

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('does not let a late authorization for an old turn overwrite the current lease', async () => {
    const fixture = linkedWorktree()
    const grants = [
      Promise.withResolvers<{
        requestReceiptId: string
        writableRoot: string
        capabilityHandle: string
      }>(),
      Promise.withResolvers<{
        requestReceiptId: string
        writableRoot: string
        capabilityHandle: string
      }>()
    ]
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn: ({ turnEpoch }) => grants[turnEpoch - 1].promise,
      consumeLease: () => {},
      onReceipt: () => {}
    })
    await gate.bindSession(SESSION, fixture.root)
    const first = gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body: BODY,
      fence: 7
    })
    const second = gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: { ...BODY, blocks: [{ type: 'text', text: 'newer correction' }] },
      fence: 8
    })

    grants[1].resolve({
      requestReceiptId: 'request-2',
      writableRoot: fixture.root,
      capabilityHandle: 'host-handle-2'
    })
    await expect(second).resolves.toBe(2)
    gate.bindTurn(SESSION, THREAD, 'turn-2', 2)
    grants[0].resolve({
      requestReceiptId: 'request-1',
      writableRoot: fixture.root,
      capabilityHandle: 'host-handle-1'
    })
    await expect(first).resolves.toBeNull()

    gate.observeNotification(SESSION, 'item/started', item('new.txt', 'item-2', 'turn-2'))
    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/fileChange/requestApproval',
        approval('item-2', 'turn-2')
      )
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })
  })

  it('ignores a stale turn binding instead of attaching it to the current request', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await gate.bindSession(SESSION, fixture.root)
    const firstEpoch = await gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body: BODY,
      fence: 7
    })
    const secondEpoch = await gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: { ...BODY, blocks: [{ type: 'text', text: 'current request' }] },
      fence: 8
    })
    expect([firstEpoch, secondEpoch]).toEqual([1, 2])

    gate.bindTurn(SESSION, THREAD, 'stale-turn', firstEpoch as number)
    gate.bindTurn(SESSION, THREAD, 'current-turn', secondEpoch as number)
    gate.observeNotification(SESSION, 'item/started', item('current.txt', 'item-2', 'current-turn'))

    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/fileChange/requestApproval',
        approval('item-2', 'current-turn')
      )
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })
  })

  it('keeps the epoch monotonic when the same durable session is rebound', async () => {
    const fixture = linkedWorktree()
    const grants = [
      Promise.withResolvers<{
        requestReceiptId: string
        writableRoot: string
        capabilityHandle: string
      }>(),
      Promise.withResolvers<{
        requestReceiptId: string
        writableRoot: string
        capabilityHandle: string
      }>(),
      Promise.withResolvers<{
        requestReceiptId: string
        writableRoot: string
        capabilityHandle: string
      }>()
    ]
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn: ({ turnEpoch }) => grants[turnEpoch - 1].promise,
      consumeLease: () => {},
      onReceipt: () => {}
    })
    await gate.bindSession(SESSION, fixture.root)
    const stale = gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-old',
      body: BODY,
      fence: 7
    })
    gate.revokeSession(SESSION)
    await gate.bindSession(SESSION, fixture.root)
    const current = gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-current',
      body: { ...BODY, blocks: [{ type: 'text', text: 'current after rebind' }] },
      fence: 8
    })
    grants[2].resolve({
      requestReceiptId: 'request-current',
      writableRoot: fixture.root,
      capabilityHandle: 'handle-current'
    })
    await expect(current).resolves.toBe(3)
    gate.bindTurn(SESSION, THREAD, 'turn-current', 3)
    grants[0].resolve({
      requestReceiptId: 'request-stale',
      writableRoot: fixture.root,
      capabilityHandle: 'handle-stale'
    })
    await expect(stale).resolves.toBeNull()

    gate.observeNotification(
      SESSION,
      'item/started',
      item('current.txt', 'item-current', 'turn-current')
    )
    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/fileChange/requestApproval',
        approval('item-current', 'turn-current')
      )
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })
  })

  it('revokes the old writer before a replacement worktree is validated', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    expect(gate.activeTurn(SESSION)).toEqual({ threadId: THREAD, turnId: TURN })

    const invalidReplacement = join(fixture.root, 'canonical')
    mkdirSync(join(invalidReplacement, '.git'), { recursive: true })
    await expect(gate.bindSession(SESSION, invalidReplacement)).rejects.toThrow(
      'linked Git worktree'
    )

    expect(gate.activeTurn(SESSION)).toBeNull()
    await expect(
      gate.openTurn({
        sessionId: SESSION,
        clientMessageId: 'client-after-failed-rebind',
        body: BODY,
        fence: 8
      })
    ).rejects.toThrow('no host-selected writable worktree')
  })

  it('keeps enforcement evidence after a new turn or process exit revokes mutation', async () => {
    const fixture = linkedWorktree()
    const receipts: CodexStructuredWriteReceipt[] = []
    const gate = authority({ receipts })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('source.txt'))
    await gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    writeFileSync(join(fixture.root, 'source.txt'), 'written\n')

    const turnEpoch = await gate.openTurn({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: { ...BODY, blocks: [{ type: 'text', text: 'stop and explain' }] },
      fence: 8
    })
    gate.observeNotification(SESSION, 'item/completed', {
      ...item('source.txt'),
      item: { ...(item('source.txt').item as object), status: 'completed' }
    })
    await expect.poll(() => receipts.length).toBe(1)
    expect(receipts[0].outcome).toBe('completed')

    expect(turnEpoch).toBe(2)
    gate.bindTurn(SESSION, THREAD, 'turn-2', turnEpoch as number)
    gate.observeNotification(SESSION, 'item/started', item('second.txt', 'item-2', 'turn-2'))
    await gate.reviewServerRequest(
      SESSION,
      'item/fileChange/requestApproval',
      approval('item-2', 'turn-2')
    )
    gate.revokeSession(SESSION)
    await expect.poll(() => receipts.length).toBe(2)
    expect(receipts[1]).toMatchObject({ toolUseId: 'item-2', outcome: 'failed' })
  })

  it.each([
    ['sibling path', '../outside.txt'],
    ['Git metadata', '.git/config']
  ])('denies %s before consuming the writer', async (_label, path) => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item(path))

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('accepts an absolute App Server path that canonicalizes into the selected root', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    const alternateRoot = fixture.root.startsWith('/private/var/')
      ? fixture.root.replace(/^\/private\/var\//, '/var/')
      : fixture.root
    gate.observeNotification(SESSION, 'item/started', item(join(alternateRoot, 'new.txt')))

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })
  })

  it('denies a symlink escape and a mismatched turn', async () => {
    const fixture = linkedWorktree()
    writeFileSync(fixture.outside, 'outside\n')
    symlinkSync(fixture.outside, join(fixture.root, 'linked.txt'))
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('linked.txt'))

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })

    await issue(gate, fixture.root, 'turn-2')
    gate.observeNotification(SESSION, 'item/started', item('new.txt', 'item-2', 'turn-2'))
    await expect(
      gate.reviewServerRequest(
        SESSION,
        'item/fileChange/requestApproval',
        approval('item-2', 'turn-wrong')
      )
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('fails closed without a host request grant or linked worktree', async () => {
    const fixture = linkedWorktree()
    const noGrant = authority({ authorize: false })
    await issue(noGrant, fixture.root)
    noGrant.observeNotification(SESSION, 'item/started', item('new.txt'))
    await expect(
      noGrant.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })

    const canonical = join(fixture.root, 'canonical')
    mkdirSync(join(canonical, '.git'), { recursive: true })
    await expect(authority({}).bindSession(SESSION, canonical)).rejects.toThrow(
      'linked Git worktree'
    )
  })

  it('declines the file change when the host cannot durably consume its admission', async () => {
    const fixture = linkedWorktree()
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn: ({ writableRoot }) => ({
        requestReceiptId: 'host-request-1',
        writableRoot,
        capabilityHandle: 'host-handle-1'
      }),
      consumeLease: async () => {
        throw new Error('admission receipt store unavailable')
      },
      onReceipt: () => {}
    })
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('new.txt'))

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('revalidates linked-worktree ownership immediately before admission', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('new.txt'))
    const marker = readFileSync(join(fixture.root, '.git'), 'utf8').trim()
    const gitDir = marker.slice('gitdir:'.length).trim()
    writeFileSync(join(gitDir, 'gitdir'), `${join(fixture.root, 'different', '.git')}\n`)

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('rejects a worktree root replaced after the host bound the session', async () => {
    const fixture = linkedWorktree()
    const gate = authority({})
    await issue(gate, fixture.root)
    gate.observeNotification(SESSION, 'item/started', item('new.txt'))
    const displaced = join(fixture.root, '..', 'displaced-worktree')
    const marker = readFileSync(join(fixture.root, '.git'), 'utf8').trim()
    const gitDir = marker.slice('gitdir:'.length).trim()
    renameSync(fixture.root, displaced)
    mkdirSync(fixture.root)
    writeFileSync(join(fixture.root, '.git'), `gitdir: ${gitDir}\n`)
    writeFileSync(join(gitDir, 'gitdir'), `${join(fixture.root, '.git')}\n`)

    await expect(
      gate.reviewServerRequest(SESSION, 'item/fileChange/requestApproval', approval())
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
  })

  it('rejects a forged linked-worktree marker without Git reciprocal ownership', async () => {
    const fixture = linkedWorktree()
    const forged = join(fixture.root, 'forged')
    mkdirSync(forged, { recursive: true })
    const gitDir = join(fixture.root, '..', 'canonical.git', 'worktrees', 'bounded')
    writeFileSync(join(forged, '.git'), `gitdir: ${gitDir}\n`)

    await expect(authority({}).bindSession(SESSION, forged)).rejects.toThrow(
      'backlink does not name the selected worktree'
    )
  })
})
