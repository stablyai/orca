import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { resumeAiVaultSessionInTerminal } from '../session/ai-vault-resume-launch'
import { prepareMobileAiVaultSessionResume } from '../session/ai-vault-resume-preparation'
import type { RpcResponse } from '../transport/types'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'

// Compare bridged and direct RPC verdicts for resume writes when replies fail/disappear; corpus covers only refusal/locked terminal.
// Assert shell-loss ambiguity separately because direct client has no bridge door to close.

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

// Await nth request: second write crosses bridge only after create settles, so an immediate absent requests[1] cannot prove it never sent.
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

// Drive writes on caller transport with observed shell rpc; direct leg uses same object, isolating bridge difference.
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
    // Include id: page isRpcResponse checks it while direct client does not; real host always sends it.
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

    // Capture ambiguity as schema field so page cannot treat create timeout as definite failure and offer duplicate-terminal retry.
    expect((await bridged).deliveryUnknown).toBe(true)
    expect(await bridged).toEqual(await direct)
  })

  // No direct comparison for shell-loss: direct fake has no bridge door, so assert property explicitly.
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
    // Earlier cases stop at create; settle it here to compare terminal.send too.
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
    // Distinguish accepted:false payload from refusal; caller owns that message branch.
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
    // Prove send was reached: failing create could produce same verdict shape.
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

    // Read raw at call site to preserve old-host fallback instead of require-result-or-throw-message failure.
    expect(await bridged).toEqual(await direct)
    expect((await bridged).codexHome).toBe(LEGACY_CODEX_HOME)
  })
})
