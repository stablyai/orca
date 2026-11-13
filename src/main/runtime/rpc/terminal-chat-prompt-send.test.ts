import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { WriteSettlement } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { readRuntimeFixture } from '../terminal/wait/agent-transcript-replay-test-harness'

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

  it.each([
    ['claude', 'claude-2-1-316-default-unlabelled-middle', 100, 30, ''],
    ['codex', 'codex-0-137-0-rotating-placeholder', 80, 24, '\x1b[20;3H\x1b[0mship it\x1b[K'],
    ['codex', 'codex-fullscreen-multiline-early-input', 120, 40, '']
  ] as const)(
    'blocks %s foreign drafts in recognized native editors before any model bytes',
    async (agent, fixture, cols, rows, typed) => {
      const { runtime, handle, writes } = await createRuntime(undefined, agent)
      vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols, rows })
      runtime.onPtyData('pty-prompt', readRuntimeFixture(fixture) + typed, Date.now())
      await runtime.readTerminal(handle, { screen: true })
      const result = await runtime.controlTerminalModel(
        handle,
        {
          agent,
          intent:
            agent === 'codex'
              ? { kind: 'picker', optionId: 'model' }
              : { kind: 'set', optionId: 'model', value: 'opus' }
        },
        { inputSource: 'desktop' }
      )
      expect(result).toEqual({ outcome: 'blocked', reason: 'foreign-draft', agent })
      expect(writes).toEqual([])
    }
  )

  it('hands unknown and unsupported editor contexts back with no effects', async () => {
    for (const agent of ['claude', 'codex', 'omp'] as const) {
      const { runtime, handle, writes } = await createRuntime(undefined, agent)
      await expect(
        runtime.controlTerminalModel(
          handle,
          { agent, intent: { kind: 'picker', optionId: 'model' } },
          { inputSource: 'desktop' }
        )
      ).resolves.toEqual({ outcome: 'legacy' })
      expect(writes).toEqual([])
    }
  })

  it('keeps the legacy route when launch metadata cannot identify the current agent', async () => {
    const { runtime, handle, writes } = await createRuntime(undefined, 'codex')
    await expect(
      runtime.controlTerminalModel(
        handle,
        {
          agent: 'claude',
          intent: { kind: 'set', optionId: 'model', value: 'opus' }
        },
        { inputSource: 'desktop' }
      )
    ).resolves.toEqual({ outcome: 'legacy' })
    expect(writes).toEqual([])
  })

  it('delivers an advertised option even when its model matches a seed without that option', async () => {
    const { runtime, handle, writes } = await createRuntime(undefined, 'claude')
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 100, rows: 30 })
    runtime.onPtyData(
      'pty-prompt',
      readRuntimeFixture('claude-2-1-316-default-unlabelled-empty'),
      Date.now()
    )
    await expect(
      runtime.controlTerminalModel(
        handle,
        {
          agent: 'claude',
          intent: { kind: 'toggle', optionId: 'fastMode', modelId: 'sonnet' }
        },
        { inputSource: 'desktop' }
      )
    ).resolves.toEqual({ outcome: 'dispatched' })
    expect(writes).toEqual(['/fast', '\r'])
  })

  it('keeps the empty native Codex picker key sequence', async () => {
    const { runtime, handle, writes } = await createRuntime(undefined, 'codex')
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 80, rows: 24 })
    runtime.onPtyData(
      'pty-prompt',
      readRuntimeFixture('codex-0-137-0-rotating-placeholder'),
      Date.now()
    )
    await runtime.readTerminal(handle, { screen: true })
    await expect(
      runtime.controlTerminalModel(
        handle,
        { agent: 'codex', intent: { kind: 'picker', optionId: 'model' } },
        { inputSource: 'desktop' }
      )
    ).resolves.toEqual({ outcome: 'picker-opened' })
    expect(writes).toEqual(['\x15', '/', 'm', 'o', 'd', 'e', 'l', '\r'])
  })

  it.each([false, true])(
    'orders the Claude warning behind command acceptance and fences foreign input=%s',
    async (foreignInput) => {
      const commandStarted = Promise.withResolvers<void>()
      const commandAccepted = Promise.withResolvers<WriteSettlement>()
      let runtime: OrcaRuntimeService
      let submits = 0
      const fixture = await createRuntime((data) => {
        if (data !== '\r') {
          return { outcome: 'accepted' }
        }
        submits++
        if (submits === 1) {
          runtime.onPtyData(
            'pty-prompt',
            'Switch model? This conversation is cached for the current model',
            Date.now()
          )
          commandStarted.resolve()
          return commandAccepted.promise
        }
        runtime.onPtyData('pty-prompt', 'Set model to Opus 5.5 (1M context)', Date.now())
        return { outcome: 'accepted' }
      }, 'claude')
      runtime = fixture.runtime
      vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 100, rows: 30 })
      runtime.onPtyData(
        'pty-prompt',
        readRuntimeFixture('claude-2-1-316-default-unlabelled-empty'),
        Date.now()
      )
      const control = runtime.controlTerminalModel(
        fixture.handle,
        {
          agent: 'claude',
          intent: { kind: 'set', optionId: 'model', value: 'claude-opus-5-5[1m]' },
          observation: {
            detectAgentInteraction: 'claude-model-switch-confirmation',
            expectedChoiceLabel: 'Claude Opus 5.5 (1M context)'
          }
        },
        { inputSource: 'desktop' }
      )
      await commandStarted.promise
      expect(fixture.writes).toEqual(['/model claude-opus-5-5[1m]', '\r'])
      if (foreignInput) {
        runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'new draft')
      }
      commandAccepted.resolve({ outcome: 'accepted' })
      await expect(control).resolves.toEqual({ outcome: foreignInput ? 'unknown' : 'applied' })
      expect(fixture.writes).toEqual(
        foreignInput
          ? ['/model claude-opus-5-5[1m]', '\r']
          : ['/model claude-opus-5-5[1m]', '\r', '\r']
      )
    }
  )

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
