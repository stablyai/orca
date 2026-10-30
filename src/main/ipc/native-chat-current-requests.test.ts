import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionCurrentRequestsPiece } from '../../shared/agent-session-current-requests-wire'
import { questionResourceFixture } from '../native-chat/message-question-resource.test-fixture'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, args: unknown) => void>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      ipc.handlers.set(name, handler),
    on: (name: string, handler: (event: unknown, args: unknown) => void) =>
      ipc.listeners.set(name, handler)
  }
}))
import { clearNativeChatSubscriptions, registerNativeChatHandlers } from './native-chat'

class Sender extends EventEmitter {
  send = vi.fn()
  isDestroyed = () => false
  constructor(readonly id: number) {
    super()
  }
}
const resources: Awaited<ReturnType<typeof questionResourceFixture>>[] = []
beforeEach(() => {
  clearNativeChatSubscriptions()
  ipc.handlers.clear()
  ipc.listeners.clear()
})
afterEach(async () => {
  clearNativeChatSubscriptions()
  for (const resource of resources.splice(0)) {
    await resource.dispose()
  }
})
async function fixture() {
  const resource = await questionResourceFixture('escaped \\" 😀'.repeat(10_000))
  resources.push(resource)
  return {
    resource,
    params: {
      agent: 'codex',
      sessionId: 'session',
      transcriptPath: resource.path,
      version: randomUUID()
    }
  }
}
async function invoke(name: string, sender: Sender, params: unknown): Promise<unknown> {
  const handler = ipc.handlers.get(name)
  if (!handler) {
    throw new Error(`Missing handler ${name}`)
  }
  return handler({ sender }, params)
}
async function read(sender: Sender, params: unknown) {
  // SAFETY: the actual registered reader returns this wire type, exercised below through assembly and marker checks.
  return (await invoke(
    'nativeChat:currentRequests',
    sender,
    params
  )) as AgentSessionCurrentRequestsPiece
}

it('assembles the same resource after its real transcript subscription ends and from another trusted renderer', async () => {
  const f = await fixture()
  registerNativeChatHandlers()
  const first = new Sender(101)
  const second = new Sender(102)
  ipc.listeners.get('nativeChat:subscribe')?.(
    { sender: first },
    {
      ...f.params,
      subscriptionId: 'interest',
      capabilities: { currentRequests: 2 }
    }
  )
  await vi.waitFor(() => expect(first.send).toHaveBeenCalled())
  const marker = await read(first, f.params)
  expect(marker.restart).toBe(true)
  const initial = await read(first, { ...f.params, version: marker.marker.version })
  expect(initial.nextCursor).not.toBeNull()
  ipc.listeners.get('nativeChat:unsubscribe')?.({ sender: first }, { subscriptionId: 'interest' })
  let json = initial.json
  let cursor = initial.nextCursor
  while (cursor !== null) {
    const next = await read(second, { ...f.params, version: initial.marker.version, cursor })
    expect(next.marker).toEqual(initial.marker)
    expect(next.restart).toBeUndefined()
    json += next.json
    cursor = next.nextCursor
  }
  expect(JSON.parse(json).asyncQuestions).toMatchObject([{ sourceRowId: 'q1' }])
  expect(JSON.parse(json).asyncQuestions).toHaveLength(1)
})

it('settles a replaced renderer read without waiting for installation and leaves its sibling usable', async () => {
  const f = await fixture()
  const ready = Promise.withResolvers<void>()
  registerNativeChatHandlers(() => ready.promise)
  const old = new Sender(103)
  const sibling = new Sender(104)
  const pending = read(old, f.params)
  const rejected = expect(pending).rejects.toThrow()
  old.emit('did-navigate')
  await rejected
  ready.resolve()
  const replacement = await read(sibling, f.params)
  expect(replacement.restart).toBe(true)
  const complete = await read(sibling, { ...f.params, version: replacement.marker.version })
  expect(complete.json.length).toBeGreaterThan(0)
})

it('validates trusted IPC Cancel input and rejects a foreign-session ID without creating a cancellation', async () => {
  const f = await fixture()
  registerNativeChatHandlers()
  const sender = new Sender(105)
  const marker = await read(sender, f.params)
  let cursor: number | null = 0
  let json = ''
  while (cursor !== null) {
    const piece = await read(sender, { ...f.params, version: marker.marker.version, cursor })
    json += piece.json
    cursor = piece.nextCursor
  }
  const ids = JSON.parse(json).asyncQuestions.map((row: { id: string }) => row.id)
  const params = { agent: 'codex', sessionId: 'session', transcriptPath: f.resource.path, ids }
  await expect(
    invoke('nativeChat:cancelCurrentQuestions', sender, { ...params, caller: 'forged' })
  ).rejects.toThrow()
  await expect(
    invoke('nativeChat:cancelCurrentQuestions', sender, { ...params, sessionId: 'foreign' })
  ).rejects.toThrow('source')
  await expect(invoke('nativeChat:cancelCurrentQuestions', sender, params)).resolves.toEqual({
    cancelled: true
  })
  const update = await read(sender, f.params)
  const complete = await read(sender, { ...f.params, version: update.marker.version })
  expect(JSON.parse(complete.json).asyncQuestions).toEqual([])
})
