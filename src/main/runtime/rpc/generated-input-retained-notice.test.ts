import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { GENERATED_INPUT_METHODS } from './methods/generated-input'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from './core'
import { createGeneratedInputNoticeFeed } from '../../../shared/generated-input-notice-feed'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import { splitGeneratedInputText } from '../../../shared/generated-terminal-input'
import type { OrcaRuntimeService } from '../orca-runtime'

const { ROWS } = vi.hoisted(() => ({
  ROWS: [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]
}))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue(ROWS)
}))
vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue(ROWS)
}))

const DIALOG =
  '\x1b[2J\x1b[HBypass Permissions\r\n❯ 1. No, exit\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel'

afterEach(() => vi.useRealTimers())

function methods() {
  const all = eraseRpcMethods(GENERATED_INPUT_METHODS)
  const unary = (name: string): RpcMethod => {
    const found = all.find((entry) => entry.name === name)
    if (!found || 'stream' in found) {
      throw new Error(`missing ${name}`)
    }
    return found
  }
  const subscribe = all.find((entry) => entry.name === 'terminal.generatedInputNotices.subscribe')!
  return {
    send: unary('terminal.sendGeneratedInput'),
    page: unary('terminal.generatedInputNotices.page'),
    dismiss: unary('terminal.dismissGeneratedInputNotice'),
    register: unary('terminal.generatedInputNotices.register'),
    subscribe
  }
}

/** One renderer's view after it (re)loads: subscribe, page the snapshot, report what it shows. */
async function reload(
  m: ReturnType<typeof methods>,
  context: RpcContext
): Promise<GeneratedAgentInputNotice[]> {
  let shown: GeneratedAgentInputNotice[] | null = null
  const feed = createGeneratedInputNoticeFeed({
    readPage: async (from) => await m.page.handler(from ?? {}, context),
    onSnapshot: (notices) => (shown = notices),
    onDelta: () => {}
  })
  if ('stream' in m.subscribe) {
    void m.subscribe.handler(null, context, feed.receive)
  }
  for (let i = 0; i < 20 && shown === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  feed.stop()
  return shown ?? []
}

// Q3: a failed generated request from a capable host's client hands its notice to the runtime
// session, which outlives a renderer reload; dismissal is the only discard.
it('keeps a failed request’s notice across reloads until it is dismissed, shown once each time', async () => {
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  runtime.onPtyData('pty-prompt', DIALOG, 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime and connection id.
  const context = { runtime, connectionId: 'renderer' } as unknown as RpcContext
  const m = methods()
  const answer = await m.send.handler(
    {
      terminal: handle,
      text: 'first line\nsecond line',
      submit: true,
      agent: 'claude',
      intent: 'running',
      timeoutMs: 200,
      retainNotice: true
    },
    context
  )
  expect(answer).toEqual({ delivery: { outcome: 'not-sent', noticeRetained: true } })
  expect(writes).toEqual([])

  const first = await reload(m, context)
  expect(first.map(({ text, certainty }) => ({ text, certainty }))).toEqual([
    { text: 'first line\nsecond line', certainty: 'not-sent' }
  ])
  // Copy reads the notice; it never removes it. A second reload shows the same one notice.
  const second = await reload(m, context)
  expect(second.map(({ id }) => id)).toEqual([first[0].id])

  await m.dismiss.handler({ id: first[0].id }, context)
  expect(await reload(m, context)).toEqual([])
})

it('leaves the notice to the client when the request does not ask the host to keep it', async () => {
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  runtime.onPtyData('pty-prompt', DIALOG, 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime and connection id.
  const context = { runtime, connectionId: 'renderer' } as unknown as RpcContext
  const m = methods()
  const answer = await m.send.handler(
    { terminal: handle, text: 'x', submit: true, agent: 'claude', timeoutMs: 200 },
    context
  )
  expect(answer).toEqual({ delivery: { outcome: 'not-sent' } })
  expect(runtime.generatedInputNotices.revision).toBe(0)
})

// The callers this runtime tells apart: a desktop window across its renderer's reloads (a new
// connection each time), another window, and a paired phone.
function viewers(runtime: OrcaRuntimeService) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime and the caller identities given here.
  const as = (fields: Record<string, string>) => ({ runtime, ...fields }) as unknown as RpcContext
  return {
    window: (connection = 'renderer-1') =>
      as({ connectionId: connection, noticeOrigin: 'desktop-window:1' }),
    otherWindow: as({ connectionId: 'renderer-9', noticeOrigin: 'desktop-window:2' }),
    phone: as({ connectionId: 'phone', pairedDeviceId: 'phone-1' }),
    // An older client: no window identity, so it only ever sees shared notices.
    oldClient: as({ connectionId: 'old' })
  }
}

const EXACT = 'line one\r\n  "quoted" \\ back\u0000slash\r\nemoji 😀 split 𝄞 end  '

async function failingSend(
  runtime: OrcaRuntimeService,
  handle: string,
  context: RpcContext,
  fields: Record<string, unknown>
) {
  runtime.onPtyData('pty-prompt', DIALOG, 0)
  return await methods().send.handler(
    {
      terminal: handle,
      submit: true,
      agent: 'claude',
      timeoutMs: 200,
      retainNotice: true,
      ...fields
    },
    context
  )
}

it('keeps one record when the reply is lost after the host kept the notice, or after delivery', async () => {
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  const v = viewers(runtime)
  // Kept by the host, reply lost: the client registers the same operation; still one notice.
  await failingSend(runtime, handle, v.window(), { text: EXACT, operationId: 'op-kept' })
  const again = { id: 'op-kept', text: EXACT, agent: 'claude', certainty: 'unconfirmed' }
  expect(await m.register.handler(again, v.window())).toEqual({ retained: true })
  expect(await m.register.handler(again, v.window())).toEqual({ retained: true })
  // Delivered, reply lost: the registration is the only record, private to the window.
  runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H\x1b[?2004h\x1b[?2031h❯ ', 0)
  expect(
    await m.register.handler(
      { id: 'op-sent', text: 'sent text', agent: 'claude', certainty: 'unconfirmed' },
      v.window()
    )
  ).toEqual({ retained: true })
  const shown = await reload(m, v.window('renderer-2'))
  expect(shown.map(({ id, text, certainty }) => ({ id, text, certainty }))).toEqual([
    { id: 'op-kept', text: EXACT, certainty: 'not-sent' },
    { id: 'op-sent', text: 'sent text', certainty: 'unconfirmed' }
  ])
  // The host's own failure stays shared as before; the lost-reply registration does not spread.
  expect((await reload(m, v.phone)).map(({ id }) => id)).toEqual(['op-kept'])
  expect((await reload(m, v.otherWindow)).map(({ id }) => id)).toEqual(['op-kept'])
  // Registration never writes to the terminal.
  expect(writes).toEqual([])
})

it('turns a request pending at a renderer reload into a notice for that window only', async () => {
  const { runtime } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  const v = viewers(runtime)
  await m.register.handler(
    { id: 'op-pending', text: EXACT, agent: null, certainty: 'unconfirmed', pending: true },
    v.window('renderer-1')
  )
  // Pending is never shown, even to its own still-running renderer.
  expect(await reload(m, v.window('renderer-1'))).toEqual([])
  // The renderer reloads (a new connection for the same window) before the request answered.
  const shown = await reload(m, v.window('renderer-2'))
  expect(shown.map(({ text, certainty, agent }) => ({ text, certainty, agent }))).toEqual([
    { text: EXACT, certainty: 'unconfirmed', agent: null }
  ])
  expect(await reload(m, v.phone)).toEqual([])
  expect(await reload(m, v.oldClient)).toEqual([])
  expect(await reload(m, v.otherWindow)).toEqual([])
})

it('never revives a dismissed operation from a late registration or completion', async () => {
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  const v = viewers(runtime)
  await m.dismiss.handler({ id: 'op-late' }, v.window())
  const late = { id: 'op-late', text: 'x', agent: 'claude', certainty: 'not-sent' }
  expect(await m.register.handler(late, v.window())).toEqual({ retained: false })
  expect(
    await failingSend(runtime, handle, v.window(), { text: 'x', operationId: 'op-late' })
  ).toEqual({
    delivery: { outcome: 'not-sent' }
  })
  expect(await reload(m, v.window('renderer-2'))).toEqual([])
  // Another client cannot dismiss a window's private notice.
  await m.register.handler({ ...late, id: 'op-mine' }, v.window())
  await m.dismiss.handler({ id: 'op-mine' }, v.phone)
  expect((await reload(m, v.window())).map(({ id }) => id)).toEqual(['op-mine'])
})

it('keeps a large exact prompt through parts, and an interrupted upload keeps the pending copy', async () => {
  const { runtime } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  const v = viewers(runtime)
  const large = `${EXACT}${'é"\\'.repeat(120 * 1024)}${EXACT}`
  const parts = splitGeneratedInputText(large)
  expect(parts.length).toBeGreaterThan(2)
  const base = { id: 'op-large', agent: 'codex', certainty: 'not-sent', submitted: false }
  for (const [index, text] of parts.entries()) {
    await m.register.handler(
      { ...base, text, part: { id: 'upload', index, final: index === parts.length - 1 } },
      v.window()
    )
  }
  // The window's pending copy of another request; its upload to the host stops after one part.
  await m.register.handler(
    { ...base, id: 'op-cut', text: large, certainty: 'unconfirmed', pending: true },
    v.window('renderer-1')
  )
  await m.register.handler(
    { ...base, id: 'op-cut', text: parts[0], part: { id: 'cut', index: 0, final: false } },
    v.window('renderer-1')
  )
  const shown = await reload(m, v.window('renderer-2'))
  expect(shown.map(({ id, text, submitted }) => ({ id, same: text === large, submitted }))).toEqual(
    [
      { id: 'op-large', same: true, submitted: false },
      { id: 'op-cut', same: true, submitted: false }
    ]
  )
})

it('ends every notice with its runtime session and never resends', async () => {
  const first = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  await failingSend(first.runtime, first.handle, viewers(first.runtime).window(), {
    text: EXACT,
    operationId: 'op-restart'
  })
  // A restarted runtime is a new session: nothing carried over, nothing written again.
  const second = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  expect(await reload(m, viewers(second.runtime).window())).toEqual([])
  expect(second.writes).toEqual([])
  expect(second.runtime.generatedInputNotices.session).not.toBe(
    first.runtime.generatedInputNotices.session
  )
})

it('streams no private frame to another subscriber and never makes it resync', async () => {
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const m = methods()
  const v = viewers(runtime)
  const received: unknown[] = []
  let pageReads = 0
  const feed = createGeneratedInputNoticeFeed({
    readPage: async (from) => {
      pageReads += 1
      return await m.page.handler(from ?? {}, v.phone)
    },
    onSnapshot: () => {},
    onDelta: (delta) => received.push(delta)
  })
  if ('stream' in m.subscribe) {
    void m.subscribe.handler(null, v.phone, (message) => {
      received.push(message)
      feed.receive(message)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 5; i += 1) {
    await m.register.handler(
      { id: `private-${i}`, text: 'secret', agent: null, certainty: 'not-sent' },
      v.window()
    )
  }
  await failingSend(runtime, handle, v.window(), { text: 'shared', operationId: 'op-shared' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(JSON.stringify(received)).not.toContain('secret')
  expect(received.filter((entry) => Object(entry).kind === 'added')).toHaveLength(1)
  expect(pageReads).toBe(1)
  feed.stop()
  runtime.cleanupSubscriptionsForConnection('phone')
})
