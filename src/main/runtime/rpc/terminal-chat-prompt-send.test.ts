import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { WriteSettlement } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

async function createRuntime(
  settle?: (data: string) => WriteSettlement | Promise<WriteSettlement>,
  agent: TuiAgent = 'omp'
) {
  let current: OrcaRuntimeService
  const writes: string[] = []
  const fixture = await createAgentPromptSubmissionRuntime(() => {}, agent, undefined, undefined, {
    writeWithSettlement: (ptyId, data, kind) => {
      current.terminalRunFacts.recordInput(ptyId, kind, data)
      writes.push(data)
      return settle?.(data) ?? { outcome: 'accepted' }
    }
  })
  current = fixture.runtime
  return { ...fixture, writes }
}

function send(runtime: OrcaRuntimeService, handle: string, text: string) {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  return dispatcher.dispatch(
    {
      id: text,
      authToken: 'token',
      method: 'terminal.send',
      params: {
        terminal: handle,
        chatPrompt: { agent: 'omp', text },
        client: { id: 'desktop-1', type: 'desktop' }
      }
    },
    { caller: { kind: 'paired-device', deviceId: 'desktop-pair' } }
  )
}

describe('host-owned Chat input', () => {
  afterEach(() => vi.useRealTimers())

  it('serializes two admitted sends without either invalidating its sibling and writes one joined Enter each', async () => {
    const { runtime, handle, writes } = await createRuntime()
    const first = send(runtime, handle, 'first')
    const second = send(runtime, handle, 'second')
    await expect(first).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    await expect(second).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(writes).toEqual([
      '\x15'.repeat(29) + '\x0b'.repeat(29),
      'first\r',
      '\x15'.repeat(29) + '\x0b'.repeat(29),
      'second\r'
    ])
  })

  it('leaves direct Terminal input alone and suppresses both an active suffix and admitted stale successor', async () => {
    vi.useFakeTimers()
    const bodyStarted = Promise.withResolvers<void>()
    const bodyAccepted = Promise.withResolvers<WriteSettlement>()
    const { runtime, handle, writes } = await createRuntime((data) => {
      if (data === 'first') {
        bodyStarted.resolve()
        return bodyAccepted.promise
      }
      return { outcome: 'accepted' }
    }, 'claude')
    const first = runtime.sendTerminalChatPrompt(handle, { agent: 'claude', text: 'first' })
    await bodyStarted.promise
    const second = runtime.sendTerminalChatPrompt(handle, { agent: 'claude', text: 'second' })
    runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'direct draft')
    bodyAccepted.resolve({ outcome: 'accepted' })
    await expect(first).resolves.toMatchObject({
      accepted: false,
      writeSettlement: { outcome: 'unverifiable' }
    })
    await expect(second).resolves.toMatchObject({ accepted: false, bytesWritten: 0 })
    await vi.runAllTimersAsync()
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), 'first'])
  })

  it('reports a first proven refusal as not sent and a later refusal as uncertain', async () => {
    const refused = await createRuntime(() => ({
      outcome: 'refused',
      reason: 'provider_refused_write'
    }))
    await expect(send(refused.runtime, refused.handle, 'first')).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    const partial = await createRuntime((data) =>
      data === 'first\r'
        ? { outcome: 'refused', reason: 'provider_refused_write' }
        : { outcome: 'accepted' }
    )
    await expect(send(partial.runtime, partial.handle, 'first')).resolves.toMatchObject({
      ok: true,
      result: {
        send: {
          accepted: false,
          writeSettlement: { outcome: 'unverifiable', bytesHandedToTransport: true }
        }
      }
    })
  })

  it('uses an unsupported-settlement provider exactly once per frame and preserves uncertainty', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (current, data) => current.terminalRunFacts.recordInput('pty-prompt', 'driving', data),
      'omp'
    )
    await expect(send(runtime, handle, 'body')).resolves.toMatchObject({
      ok: true,
      result: {
        send: {
          accepted: false,
          writeSettlement: { outcome: 'unverifiable', bytesHandedToTransport: true }
        }
      }
    })
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), 'body\r'])
  })

  it('never submits a delayed suffix into a replacement process generation', async () => {
    vi.useFakeTimers()
    const bodyStarted = Promise.withResolvers<void>()
    const bodyAccepted = Promise.withResolvers<WriteSettlement>()
    const { runtime, handle, writes } = await createRuntime((data) => {
      if (data === 'body') {
        bodyStarted.resolve()
        return bodyAccepted.promise
      }
      return { outcome: 'accepted' }
    }, 'claude')
    const pending = runtime.sendTerminalChatPrompt(handle, { agent: 'claude', text: 'body' })
    await bodyStarted.promise
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-prompt')
    )
    bodyAccepted.resolve({ outcome: 'accepted' })
    await expect(pending).resolves.toMatchObject({
      accepted: false,
      writeSettlement: { outcome: 'unverifiable' }
    })
    await vi.runAllTimersAsync()
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), 'body'])
  })
})
