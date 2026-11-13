import * as RuntimeClock from '../hosts/runtime-elapsed-clock'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { WriteSettlement } from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import {
  installOwnership,
  PROVIDER_SESSION
} from '../../ai-vault/structured-sessions/structured-session-ownership.test-support'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

async function createRuntime(
  settle?: (data: string) => WriteSettlement | Promise<WriteSettlement>,
  agent: TuiAgent = 'omp',
  controller?: Partial<NonNullable<Parameters<OrcaRuntimeService['setPtyController']>[0]>>
) {
  let current: OrcaRuntimeService
  const writes: string[] = []
  const fixture = await createAgentPromptSubmissionRuntime(() => {}, agent, undefined, undefined, {
    ...controller,
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
  afterEach(() => {
    setStructuredAgentSessionHost(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('blocks an owned resume only at a proven shell and preserves the identical agent prompt', async () => {
    installOwnership()
    const text = `codex resume ${PROVIDER_SESSION}`
    const shell = await createRuntime(undefined, 'omp', {
      confirmShellForeground: async () => true
    })
    vi.spyOn(shell.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    await expect(send(shell.runtime, shell.handle, text)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(shell.writes).toEqual([])

    const agent = await createRuntime(undefined, 'omp', {
      confirmShellForeground: async () => false,
      supportsForegroundObservation: () => true,
      inspectProcess: async (ptyId, options) => ({
        foregroundProcess: 'codex',
        hasChildProcesses: true,
        foregroundObservation: {
          ptyId,
          ptyIncarnationId: options!.expectedIncarnationId!,
          authorityGeneration: 'host-agent',
          observationEpoch: 1,
          capturedAgeMs: 0,
          verdict: 'observed',
          source: 'windows-console',
          foregroundKind: 'non-shell',
          processName: 'codex'
        }
      })
    })
    await expect(send(agent.runtime, agent.handle, text)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(agent.writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), `${text}\r`])

    const unknown = await createRuntime()
    await expect(send(unknown.runtime, unknown.handle, text)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(unknown.writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), `${text}\r`])
  })

  it('rechecks the receiver after ownership lookup and does not probe ordinary messages', async () => {
    installOwnership()
    const lookup = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let shell = true
    const { runtime, handle, writes } = await createRuntime(undefined, 'omp', {
      confirmShellForeground: async () => shell
    })
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(() => {
      entered.resolve()
      return lookup.promise
    })
    const text = `codex resume ${PROVIDER_SESSION}`
    const pending = send(runtime, handle, text)
    await entered.promise
    shell = false
    lookup.resolve()
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), `${text}\r`])

    const foreground = vi.fn(async () => true)
    const ordinary = await createRuntime(undefined, 'omp', { confirmShellForeground: foreground })
    const lookupOrdinary = vi.spyOn(ordinary.runtime, 'ensureStructuredAgentSessionHost')
    await expect(send(ordinary.runtime, ordinary.handle, 'hello')).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(lookupOrdinary).not.toHaveBeenCalled()
    expect(foreground).not.toHaveBeenCalled()
    expect(ordinary.writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), 'hello\r'])
  })

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

  it('admits a large Windows Chat paste through the late-marker ceiling and sends exactly one Enter', async () => {
    vi.useFakeTimers()
    vi.spyOn(RuntimeClock, 'readRuntimeElapsedClock').mockImplementation(() => ({
      lower: 100000 + Math.floor(performance.now()),
      upper: 100001 + Math.floor(performance.now())
    }))
    const bodyStarted = Promise.withResolvers<void>()
    const text = 'x'.repeat(2000000)
    const framed = `\x1b[200~${text}\x1b[201~`
    const { runtime, handle, writes } = await createRuntime((data) => {
      if (data === framed) {
        bodyStarted.resolve()
      }
      return { outcome: 'accepted' }
    }, 'claude')
    Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
    const pending = runtime.sendTerminalChatPrompt(handle, {
      agent: 'claude',
      text,
      expiry: { runtimeId: runtime.getRuntimeId(), expiresAtMs: 200000 }
    })
    await bodyStarted.promise
    await vi.advanceTimersByTimeAsync(39000)
    vi.setSystemTime(-100000000)
    runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(500)
      runtime.onPtyData('pty-prompt', '.', Date.now())
    }
    await vi.advanceTimersByTimeAsync(31000)
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), framed])
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), framed, '\r'])
  })

  it('keeps old no-grant scheduling bounded before effects and allows a qualified no-gate large paste', async () => {
    vi.useFakeTimers()
    vi.spyOn(RuntimeClock, 'readRuntimeElapsedClock').mockImplementation(() => ({
      lower: 100000 + Math.floor(performance.now()),
      upper: 100001 + Math.floor(performance.now())
    }))
    const body = Promise.withResolvers<void>()
    const text = 'x'.repeat(2000000)
    const framed = `\x1b[200~${text}\x1b[201~`
    const { runtime, handle, writes } = await createRuntime((data) => {
      if (data === framed) {
        body.resolve()
      }
      return { outcome: 'accepted' }
    }, 'grok')
    Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
    await expect(
      runtime.sendTerminalChatPrompt(handle, { agent: 'grok', text })
    ).resolves.toMatchObject({ accepted: false, bytesWritten: 0 })
    expect(writes).toEqual([])
    const pending = runtime.sendTerminalChatPrompt(handle, {
      agent: 'grok',
      text,
      expiry: { runtimeId: runtime.getRuntimeId(), expiresAtMs: 200000 }
    })
    await body.promise
    await vi.advanceTimersByTimeAsync(31750)
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), framed])
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), framed, '\r'])
  })

  it('rejects delayed or foreign-runtime grants before clear and suppresses an expired suffix without a timer wake', async () => {
    vi.useFakeTimers()
    let hostNow = 100000
    vi.spyOn(RuntimeClock, 'readRuntimeElapsedClock').mockImplementation(() => ({
      lower: hostNow,
      upper: hostNow + 1
    }))
    const bodyStarted = Promise.withResolvers<void>()
    const acceptBody = Promise.withResolvers<WriteSettlement>()
    const { runtime, handle, writes } = await createRuntime((data) => {
      if (data === 'body') {
        bodyStarted.resolve()
        return acceptBody.promise
      }
      return { outcome: 'accepted' }
    }, 'claude')
    for (const expiry of [
      { runtimeId: 'replaced-runtime', expiresAtMs: 150000 },
      { runtimeId: runtime.getRuntimeId(), expiresAtMs: 100001 }
    ]) {
      await expect(
        runtime.sendTerminalChatPrompt(handle, { agent: 'claude', text: 'body', expiry })
      ).resolves.toMatchObject({ accepted: false, bytesWritten: 0 })
    }
    expect(writes).toEqual([])
    const pending = runtime.sendTerminalChatPrompt(handle, {
      agent: 'claude',
      text: 'body',
      expiry: { runtimeId: runtime.getRuntimeId(), expiresAtMs: 150000 }
    })
    await bodyStarted.promise
    hostNow = 150001
    acceptBody.resolve({ outcome: 'accepted' })
    await vi.advanceTimersByTimeAsync(8001)
    await expect(pending).resolves.toMatchObject({
      accepted: false,
      writeSettlement: { outcome: 'unverifiable' }
    })
    expect(writes).toEqual(['\x15'.repeat(29) + '\x0b'.repeat(29), 'body'])
  })
})
