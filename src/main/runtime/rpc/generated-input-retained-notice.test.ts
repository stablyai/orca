import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { GENERATED_INPUT_METHODS } from './methods/generated-input'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from './core'
import { createGeneratedInputNoticeFeed } from '../../../shared/generated-input-notice-feed'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'

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
