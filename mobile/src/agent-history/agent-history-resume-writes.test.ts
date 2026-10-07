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
 *
 * One case has no second leg and cannot have one: a shell that goes away mid-write is something
 * only the bridged transport can do, so there is no native run to compare it against. It asserts
 * the property directly instead, and says so where it is.
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
  return nthRequest(rpc, flush, 0)
}

/**
 * The nth request, waited for rather than read once.
 *
 * A resume is two writes and the second is only made after the first settles, so on the bridged
 * leg it is two more lane round trips away: reading `requests[1]` straight after settling the
 * create finds nothing, and a test that treated that as "the send never happened" would pass while
 * proving the opposite of what it says.
 */
async function nthRequest(
  rpc: FakeRpcClient,
  flush: () => Promise<void>,
  index: number
): Promise<FakeRpcClient['requests'][number]> {
  for (let attempt = 0; attempt < 10 && rpc.requests.length <= index; attempt += 1) {
    await flush()
  }
  const request = rpc.requests[index]
  if (request === undefined) {
    throw new Error(`request ${index} never reached the shell (saw ${rpc.requests.length})`)
  }
  return request
}

/** A create the send below is addressed to: the one reply shape the tab reader accepts. */
const CREATED_TERMINAL: RpcResponse = {
  id: 'reply-create',
  ok: true,
  result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } },
  _meta: { runtimeId: 'runtime-a' }
}

/**
 * Drives both writes on one transport and returns what the caller was left with.
 *
 * `caller` is what the screen holds and `rpc` is what the shell holds; on the direct leg they are
 * the same object, which is the point — the only difference between the two runs is the bridge.
 */
async function resumeVerdict(args: {
  caller: Parameters<typeof resumeAiVaultSessionInTerminal>[0]
  rpc: FakeRpcClient
  flush: () => Promise<void>
  sendReply: RpcResponse
}): Promise<Verdict> {
  const run = verdictOf(resumeAiVaultSessionInTerminal(args.caller, 'wt-1', LAUNCH))
  ;(await nthRequest(args.rpc, args.flush, 0)).resolve(CREATED_TERMINAL)
  ;(await nthRequest(args.rpc, args.flush, 1)).resolve(args.sendReply)
  await args.flush()
  return run
}

/** Both legs of one send reply, so a case reads as the one comparison it is making. */
async function bothLegs(sendReply: RpcResponse): Promise<{ bridged: Verdict; direct: Verdict }> {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  const bridged = await resumeVerdict({
    caller: pair.client,
    rpc: pair.rpc,
    flush: pair.flush,
    sendReply
  })
  const native = createFakeRpcClient()
  const direct = await resumeVerdict({
    caller: native,
    rpc: native,
    flush: async () => {},
    sendReply
  })
  return { bridged, direct }
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

  // The one case with no direct leg: a fake RPC client has no door to shut, so there is no native
  // run to compare against. The property is asserted rather than differenced.
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

  it('raises the host message on a refused send, which no earlier case reached', async () => {
    // Every case above settles the create, so `terminal.send` had never crossed the bridge at all
    // and the second half of the resume was uncompared.
    const { bridged, direct } = await bothLegs({
      id: 'reply-send',
      ok: false,
      error: { code: 'busy', message: 'That terminal is gone.' },
      _meta: { runtimeId: 'runtime-a' }
    })
    expect(bridged).toEqual(direct)
    expect(bridged).toEqual({ message: 'That terminal is gone.', deliveryUnknown: false })
  })

  it('says the terminal is locked when the send is accepted and refuses in-band', async () => {
    // An accepted envelope reporting `accepted: false` is a different failure from a refused send,
    // and it is the branch the caller words itself; the reader answers that one question.
    const { bridged, direct } = await bothLegs({
      id: 'reply-send',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'runtime-a' }
    })
    expect(bridged).toEqual(direct)
    expect(bridged).toEqual({ message: 'Terminal input is locked', deliveryUnknown: false })
  })

  it('resolves through both writes when the host takes them, on both transports', async () => {
    // The presence precondition for the two above: a run that failed at the create would give the
    // same shape of verdict, and this is what says the send is reached at all.
    const { bridged, direct } = await bothLegs({
      id: 'reply-send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime-a' }
    })
    expect(bridged).toEqual(direct)
    expect(bridged).toEqual({ message: '(resolved)', deliveryUnknown: false })
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
