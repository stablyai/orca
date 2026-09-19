import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { resumeAiVaultSessionInTerminal } from '../session/ai-vault-resume-launch'
import { prepareMobileAiVaultSessionResume } from '../session/ai-vault-resume-preparation'
import type { RpcResponse } from '../transport/types'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'

/**
 * The three writes a resume makes, answered by the shell's own RPC client instead of the page's.
 *
 * These are the modes no golden replays: the corpus scripts a refusal and a locked terminal, and
 * nothing in it loses a reply or closes the door mid-flight. The claim under test is not that the
 * page has its own handling — it has none, and should have none — but that the descriptor's
 * handling survives the extra hop, so the native screen and the page fail identically.
 *
 * Each case is run twice, once on a client the page holds through the bridge and once on the same
 * fake directly, and the two verdicts are compared rather than written down. A change that moved
 * the native behaviour would move both and pass a written-down expectation.
 */

const LAUNCH = { command: 'codex resume abc' }

/** The one home shape that makes a Codex resume ask the host to repin at all. */
const LEGACY_CODEX_HOME = '/Users/ada/Library/Application Support/orca/codex-runtime-home/home'

const SESSION: AiVaultSession = {
  id: 'codex:legacy-1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'legacy-1',
  title: 'Resume me',
  cwd: '/Users/ada/repo',
  branch: 'main',
  model: null,
  filePath: `${LEGACY_CODEX_HOME}/sessions/2026/07/20/rollout-a.jsonl`,
  codexHome: LEGACY_CODEX_HOME,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-07-20T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 10,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}

/** What a caller saw: the message it would paint, and whether the send was ambiguous. */
type Verdict = { message: string; deliveryUnknown: boolean }

async function verdictOf(run: Promise<unknown>): Promise<Verdict> {
  try {
    await run
    return { message: '(resolved)', deliveryUnknown: false }
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      deliveryUnknown: isRpcDeliveryUnknown(error)
    }
  }
}

/** The first request the shell's client was asked to make, once the page's frame has crossed. */
async function firstRequest(
  rpc: FakeRpcClient,
  flush: () => Promise<void>
): Promise<FakeRpcClient['requests'][number]> {
  await flush()
  const request = rpc.requests[0]
  if (request === undefined) {
    throw new Error('the write never reached the shell')
  }
  return request
}

describe('a resume write through the bridge answers the caller as the native client does', () => {
  it('raises the host message on a refused create, on both transports', async () => {
    // `id`, because the page reads the reply with `isRpcResponse` where the native client does
    // not: a real host always sends one, and a double without one is not the reply under test.
    const refusal: RpcResponse = {
      id: 'reply-1',
      ok: false,
      error: { code: 'busy', message: 'No room for a terminal.' },
      _meta: { runtimeId: 'runtime-a' }
    }

    const pair = createFakeBridgePortPair()
    await pair.flush()
    const bridged = verdictOf(resumeAiVaultSessionInTerminal(pair.client, 'wt-1', LAUNCH))
    ;(await firstRequest(pair.rpc, pair.flush)).resolve(refusal)
    await pair.flush()

    const native = createFakeRpcClient()
    const direct = verdictOf(resumeAiVaultSessionInTerminal(native, 'wt-1', LAUNCH))
    ;(await firstRequest(native, async () => {})).resolve(refusal)

    expect(await bridged).toEqual(await direct)
    expect(await bridged).toEqual({
      message: 'No room for a terminal.',
      deliveryUnknown: false
    })
  })

  it('keeps a lost reply ambiguous rather than reporting a failure the user can retry blindly', async () => {
    const lost = () =>
      markRpcDeliveryUnknown(new Error('Request timed out: session.tabs.createTerminal'))

    const pair = createFakeBridgePortPair()
    await pair.flush()
    const bridged = verdictOf(resumeAiVaultSessionInTerminal(pair.client, 'wt-1', LAUNCH))
    ;(await firstRequest(pair.rpc, pair.flush)).reject(lost())
    await pair.flush()

    const native = createFakeRpcClient()
    const direct = verdictOf(resumeAiVaultSessionInTerminal(native, 'wt-1', LAUNCH))
    ;(await firstRequest(native, async () => {})).reject(lost())

    // The mark is a schema field on the captured error, so it crosses; without that the page would
    // read a timed-out create as a definite failure and offer a retry that duplicates a terminal.
    expect((await bridged).deliveryUnknown).toBe(true)
    expect(await bridged).toEqual(await direct)
  })

  it('leaves a write in flight when the shell goes ambiguous, not failed', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const bridged = verdictOf(resumeAiVaultSessionInTerminal(pair.client, 'wt-1', LAUNCH))
    await firstRequest(pair.rpc, pair.flush)
    // The door shutting on an in-flight create: the desktop may already have run it.
    pair.host.dispose()
    await pair.flush()
    expect((await bridged).deliveryUnknown).toBe(true)
  })

  it('resumes on the shared home when an older host cannot prepare, through the bridge too', async () => {
    const unavailable: RpcResponse = {
      id: 'reply-1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime-a' }
    }

    const pair = createFakeBridgePortPair()
    await pair.flush()
    const bridged = prepareMobileAiVaultSessionResume(pair.client, SESSION)
    ;(await firstRequest(pair.rpc, pair.flush)).resolve(unavailable)
    await pair.flush()

    const native = createFakeRpcClient()
    const direct = prepareMobileAiVaultSessionResume(native, SESSION)
    ;(await firstRequest(native, async () => {})).resolve(unavailable)

    // Read raw at the call site rather than through the acceptance policy, which is what makes an
    // older host a fallback instead of the failure `require-result-or-throw-message` would give.
    expect(await bridged).toEqual(await direct)
    expect((await bridged).codexHome).toBe(LEGACY_CODEX_HOME)
  })
})
