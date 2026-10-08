import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { ptyInputTransactions, PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS } from './pty-input-transactions'
import { bindProviderPtyInput } from '../ipc/pty/provider/input-binding'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { createLaunchedAgentWriteGuard } from './launched-agent-write-guard'
import { createPtyWriteInput } from '../ipc/pty/ipc/write-input'
import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'

const PTY = 'pty-input-ownership'
const { provider } = vi.hoisted(() => ({
  provider: {
    write: vi.fn<(id: string, data: string) => boolean>(),
    writeWithSettlement: vi.fn<
      (id: string, data: string) => WriteSettlement | Promise<WriteSettlement>
    >(() => WRITE_ACCEPTED),
    hasPty: () => true
  }
}))

vi.mock('../ipc/pty/provider/registry', () => ({ tryGetProviderForPty: () => provider }))
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/input',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/input',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

beforeEach(() => {
  vi.useFakeTimers()
  provider.write.mockReset()
  ptyOwnership.set(PTY, null)
  ptyIncarnationById.set(PTY, 'inc-1')
})

afterEach(() => {
  ptyOwnership.delete(PTY)
  ptyIncarnationById.delete(PTY)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function harness(agent: 'aider' | 'codex' = 'aider') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this established fixture provides the store operations used by the runtime.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const bytes: string[] = []
  provider.write.mockImplementation((_id, data) => {
    bytes.push(data)
    return true
  })
  provider.writeWithSettlement.mockImplementation((_id: string, data: string) => {
    bytes.push(data)
    return WRITE_ACCEPTED
  })
  const installController = () =>
    runtime.setPtyController({
      spawn: async () => ({ id: PTY, incarnationId: 'inc-1' }),
      bindInput: bindProviderPtyInput,
      write: (id, data) => provider.write(id, data),
      writeWithSettlement: (id, data) => provider.writeWithSettlement(id, data),
      hasPty: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
  installController()
  const terminal = await runtime.createTerminal('path:/tmp/worktree-a', { launchAgent: agent })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const handle = terminal.handle
  const desktop = createPtyWriteInput({ runtime })
  const send = (text: string, signal?: AbortSignal) =>
    runtime.sendTerminal(
      handle,
      { text, enter: true },
      {
        inputKind: 'driving',
        requireWriteSettlement: true,
        signal
      }
    )
  return { runtime, bytes, handle, desktop, send, installController }
}

describe('runtime and desktop share PTY input ownership', () => {
  it.each(['accepted', 'thrown'] as const)(
    'releases typing at the external-await backstop despite a stalled provider, including a late %s settlement',
    async (late) => {
      const h = await harness()
      const text = 'A'.repeat(40_000)
      const holdMs = PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS
      let settle: (value: WriteSettlement) => void = () => {}
      let fail: (error: Error) => void = () => {}
      const stalled = new Promise<WriteSettlement>((resolve, reject) => {
        settle = resolve
        fail = reject
      })
      let handedOffAt = 0
      provider.writeWithSettlement.mockImplementationOnce((_id, data) => {
        handedOffAt = Date.now()
        h.bytes.push(data)
        return stalled
      })
      let sendSettled = false
      const a = h.send(text).then((result) => {
        sendSettled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(0)
      const firstChunk = h.bytes[0]
      const x = h.desktop.writePtyInput({ id: PTY, data: 'x', inputKind: 'driving' })
      const y = h.desktop.writePtyInput({ id: PTY, data: 'y', inputKind: 'driving' })
      const b = h.send('B')
      await vi.advanceTimersByTimeAsync(handedOffAt + holdMs - Date.now() - 1)
      expect(sendSettled).toBe(false)
      expect(h.bytes).toEqual([firstChunk])
      await vi.advanceTimersByTimeAsync(1)
      expect(await a).toMatchObject({
        accepted: false,
        writeSettlement: {
          outcome: 'unverifiable',
          reason: 'partial_write',
          bytesHandedToTransport: true
        }
      })
      expect(await x).toBe(true)
      expect(await y).toBe(true)
      expect(h.bytes).toEqual([firstChunk, 'x', 'y', 'B'])
      expect(ptyInputTransactions.size).toBe(1)
      if (late === 'accepted') {
        settle(WRITE_ACCEPTED)
      } else {
        fail(new Error('late provider failure'))
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(h.bytes).toEqual([firstChunk, 'x', 'y', 'B'])
      expect(ptyInputTransactions.size).toBe(1)
      await vi.runAllTimersAsync()
      expect(await b).toMatchObject({ accepted: true })
      expect(h.bytes).toEqual([firstChunk, 'x', 'y', 'B', '\r'])
      expect(ptyInputTransactions.size).toBe(0)
    }
  )

  it.each(['beforeWrite', 'afterWrite'] as const)(
    'abandons a stalled %s callback and fences its later continuation',
    async (callback) => {
      const h = await harness()
      let release: () => void = () => {}
      const stalled = new Promise<void>((resolve) => {
        release = resolve
      })
      const startedAt = Date.now()
      const send = h.runtime.sendTerminal(
        h.handle,
        { text: 'A', enter: true },
        {
          inputKind: 'driving',
          requireWriteSettlement: true,
          [callback]: () => stalled
        }
      )
      const failure =
        callback === 'beforeWrite'
          ? expect(send).rejects.toMatchObject({
              message: 'request_timeout',
              bytesHandedToTransport: false
            })
          : expect(send).resolves.toMatchObject({
              accepted: false,
              writeSettlement: { reason: 'partial_write' }
            })
      await vi.advanceTimersByTimeAsync(0)
      const key = h.desktop.writePtyInput({ id: PTY, data: 'key', inputKind: 'driving' })
      await vi.advanceTimersByTimeAsync(
        startedAt + PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS - Date.now()
      )
      await failure
      expect(await key).toBe(true)
      const expectedBytes = callback === 'beforeWrite' ? ['key'] : ['A', 'key']
      expect(h.bytes).toEqual(expectedBytes)
      expect(ptyInputTransactions.size).toBe(0)
      release()
      await vi.runAllTimersAsync()
      expect(h.bytes).toEqual(expectedBytes)
      expect(ptyInputTransactions.size).toBe(0)
    }
  )

  it('abandons a stalled prompt submit without a later submit, resubmit or accepted receipt', async () => {
    const h = await harness('codex')
    let release: () => void = () => {}
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    const beforeWrite = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => stalled)
    const onInputAccepted = vi.fn()
    const options = {
      inputKind: 'driving',
      composerReady: true,
      acceptQueued: true,
      requestId: 'held-prompt',
      beforeWrite,
      onInputAccepted
    } as const
    const startedAt = Date.now()
    const prompt = h.runtime.sendTerminalAgentPrompt(h.handle, 'prompt', options)
    await vi.advanceTimersByTimeAsync(100)
    const paste = h.bytes[0]
    const key = h.desktop.writePtyInput({ id: PTY, data: 'key', inputKind: 'driving' })
    await vi.advanceTimersByTimeAsync(
      startedAt + PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS + 100 - Date.now()
    )
    expect(await prompt).toMatchObject({
      accepted: false,
      bytesWritten: Buffer.byteLength(paste),
      writeSettlement: { reason: 'partial_write' }
    })
    expect(await key).toBe(true)
    expect(h.bytes).toEqual([paste, 'key'])
    expect(onInputAccepted).not.toHaveBeenCalled()
    expect(ptyInputTransactions.size).toBe(0)
    release()
    await vi.runAllTimersAsync()
    expect(h.bytes).toEqual([paste, 'key'])
    expect(onInputAccepted).not.toHaveBeenCalled()
  })

  it('finishes input across controller reinstallation when the provider incarnation is unchanged', async () => {
    const h = await harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    h.installController()
    const b = h.send('B')
    await vi.runAllTimersAsync()
    expect(await a).toMatchObject({ accepted: true })
    expect(await b).toMatchObject({ accepted: true })
    expect(h.bytes).toEqual(['A', '\r', 'B', '\r'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it('fences obsolete input before writing to a replacement incarnation', async () => {
    const h = await harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const obsolete = h.desktop.writePtyInput({ id: PTY, data: 'old', inputKind: 'driving' })
    ptyIncarnationById.set(PTY, 'inc-2')
    const replacement = h.desktop.writePtyInput({ id: PTY, data: 'new', inputKind: 'driving' })
    expect(h.bytes).toEqual(['A'])
    await vi.runAllTimersAsync()
    expect(await a).toMatchObject({ accepted: false, writeSettlement: { reason: 'partial_write' } })
    expect(await obsolete).toBe(false)
    expect(await replacement).toBe(true)
    expect(h.bytes).toEqual(['A', 'new'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it('sends two complete commands before desktop keystrokes and keeps keystrokes synchronous when free', async () => {
    const h = await harness()
    expect(h.desktop.writePtyInput({ id: PTY, data: 'x', inputKind: 'driving' })).toBe(true)
    expect(h.desktop.writePtyInput({ id: PTY, data: 'y', inputKind: 'driving' })).toBe(true)
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const b = h.send('B')
    await vi.advanceTimersByTimeAsync(0)
    const key = h.desktop.writePtyInput({ id: PTY, data: 'z', inputKind: 'driving' })
    expect(h.bytes).toEqual(['x', 'y', 'A'])
    await vi.runAllTimersAsync()
    await Promise.all([a, b, key])
    expect(h.bytes).toEqual(['x', 'y', 'A', '\r', 'B', '\r', 'z'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it.each(['desktop', 'paired'] as const)(
    'preempts from %s raw input and preserves queued send order',
    async (source) => {
      const h = await harness()
      const a = h.send('A')
      await vi.advanceTimersByTimeAsync(0)
      const b = h.send('B')
      await vi.advanceTimersByTimeAsync(0)
      const interrupt =
        source === 'desktop'
          ? h.desktop.writePtyInputAccepted({ id: PTY, data: '\x03', inputKind: 'driving' })
          : h.runtime.sendTerminal(h.handle, { text: '\x03' }, { inputKind: 'driving' })
      await vi.runAllTimersAsync()
      expect(await a).toMatchObject({
        accepted: false,
        writeSettlement: { reason: 'partial_write' }
      })
      await Promise.all([b, interrupt])
      expect(h.bytes).toEqual(['A', '\x03', 'B', '\r'])
      expect(ptyInputTransactions.size).toBe(0)
    }
  )

  it('lets protocol replies through a held transaction while ordinary query-labelled input queues', async () => {
    const h = await harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.desktop.writePtyInput({ id: PTY, data: '\x1b[3;4R', inputKind: 'query-reply' })).toBe(
      true
    )
    const ordinary = h.desktop.writePtyInput({
      id: PTY,
      data: 'ordinary',
      inputKind: 'query-reply'
    })
    expect(h.bytes).toEqual(['A', '\x1b[3;4R'])
    await vi.runAllTimersAsync()
    await Promise.all([a, ordinary])
    expect(h.bytes.at(-1)).toBe('ordinary')
  })

  it('queues plain sends after prompt submission and releases input before turn verification', async () => {
    const h = await harness()
    let promptSettled = false
    const prompt = h.runtime
      .sendTerminalAgentPrompt(h.handle, 'prompt', {
        inputKind: 'driving',
        composerReady: true
      })
      .then((result) => {
        promptSettled = true
        return result
      })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.bytes).toHaveLength(1)
    const queued = h.send('queued')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.bytes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.bytes.slice(1)).toEqual(['\r', 'queued', '\r'])
    expect(promptSettled).toBe(false)
    expect(ptyInputTransactions.size).toBe(0)
    const observing = h.send('observing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.bytes.slice(-2)).toEqual(['observing', '\r'])
    h.runtime.onPtyData(PTY, '\x1b]0;Codex working\x07', Date.now())
    await vi.runAllTimersAsync()
    await Promise.all([prompt, queued, observing])
  })

  it('delivers Ctrl-C during the prompt render gate without advancing its timer', async () => {
    const h = await harness('codex')
    const prompt = h.runtime.sendTerminalAgentPrompt(h.handle, 'prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'render-preempt'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.bytes).toHaveLength(1)
    const interrupt = h.desktop.writePtyInput({ id: PTY, data: '\x03', inputKind: 'driving' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await prompt).toMatchObject({
      accepted: false,
      bytesWritten: Buffer.byteLength(h.bytes[0]),
      writeSettlement: { reason: 'partial_write' }
    })
    expect(await interrupt).toBe(true)
    expect(h.bytes.slice(1)).toEqual(['\x03'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it.each(['desktop', 'paired', 'preview'] as const)(
    'keeps %s typed ls and Enter before Ctrl-C while skipping later programmatic sends',
    async (source) => {
      const h = await harness()
      const active = h.send('A')
      await vi.advanceTimersByTimeAsync(0)
      const earlierSend = h.send('earlier')
      await vi.advanceTimersByTimeAsync(0)
      const writeRaw = (data: string) =>
        source === 'desktop'
          ? h.desktop.writePtyInput({ id: PTY, data, inputKind: 'driving' })
          : source === 'preview'
            ? h.runtime.writeTerminalPreviewInput(PTY, data)
            : h.runtime.sendTerminal(
                h.handle,
                { text: data },
                { inputKind: 'driving', rawInput: true }
              )
      const typed = writeRaw('ls\r')
      await vi.advanceTimersByTimeAsync(0)
      const laterSend = h.send('later')
      await vi.advanceTimersByTimeAsync(0)
      const interrupt = writeRaw('\x03')
      await vi.advanceTimersByTimeAsync(0)
      expect(await active).toMatchObject({ accepted: false, bytesWritten: 1 })
      expect(h.bytes).toEqual(['A', 'earlier'])
      await vi.runAllTimersAsync()
      await Promise.all([earlierSend, typed, laterSend, interrupt])
      expect(h.bytes).toEqual(['A', 'earlier', '\r', 'ls\r', '\x03', 'later', '\r'])
    }
  )

  it('returns false for verified input refused in the queue before any handoff', async () => {
    const h = await harness()
    const active = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const queued = h.desktop.writePtyInputAccepted({
      id: PTY,
      data: 'answer',
      inputKind: 'driving',
      requireWriteSettlement: true
    })
    ptyIncarnationById.set(PTY, 'inc-2')
    await vi.runAllTimersAsync()
    expect(await active).toMatchObject({ accepted: false })
    expect(await queued).toBe(false)
    expect(h.bytes).toEqual(['A'])
  })

  it('waits for a healthy single-write acknowledgment beyond the old hold', async () => {
    const h = await harness()
    provider.writeWithSettlement.mockImplementationOnce((_id, data) => {
      h.bytes.push(data)
      return new Promise<WriteSettlement>((resolve) =>
        setTimeout(() => resolve(WRITE_ACCEPTED), 4_000)
      )
    })
    const answer = h.desktop.writePtyInputAccepted({
      id: PTY,
      data: 'answer',
      inputKind: 'driving',
      requireWriteSettlement: true
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.bytes).toEqual(['answer'])
    const key = h.desktop.writePtyInput({ id: PTY, data: 'key', inputKind: 'driving' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await answer).toBe(true)
    expect(await key).toBe(true)
    expect(h.bytes).toEqual(['answer', 'key'])
  })

  it('keeps typing synchronous while the first launch foreground proof is pending', async () => {
    const h = await harness('codex')
    let prove: () => void = () => {}
    vi.mocked(h.runtime.readLaunchedAgentForeground).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          prove = () => resolve('agent')
        })
    )
    const guard = createLaunchedAgentWriteGuard(h.runtime, 'codex')
    const prompt = h.runtime.sendTerminalAgentPrompt(h.handle, 'prompt', {
      inputKind: 'launch',
      composerReady: true,
      beforeWrite: guard.beforeWrite,
      acceptQueued: true,
      requestId: 'slow-launch',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(ptyInputTransactions.size).toBe(0)
    expect(h.desktop.writePtyInput({ id: PTY, data: 'key', inputKind: 'driving' })).toBe(true)
    prove()
    await vi.runAllTimersAsync()
    expect(await prompt).toMatchObject({ accepted: true })
    expect(h.bytes[0]).toBe('key')
    expect(h.runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(1)
    guard.dispose()
  })

  it('keeps the submitted prompt accepted when the optional resubmit guard stalls', async () => {
    const h = await harness('codex')
    const beforeWrite = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise<void>(() => {}))
    const onInputAccepted = vi.fn()
    const prompt = h.runtime.sendTerminalAgentPrompt(h.handle, 'prompt', {
      inputKind: 'driving',
      composerReady: true,
      beforeWrite,
      acceptQueued: true,
      requestId: 'submitted-before-stall',
      observationTimeoutMs: 0,
      onInputAccepted
    })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.bytes.slice(1)).toEqual(['\r'])
    const key = h.desktop.writePtyInput({ id: PTY, data: 'key', inputKind: 'driving' })
    await vi.advanceTimersByTimeAsync(PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS)
    const bytesWritten = Buffer.byteLength(h.bytes[0]) + 1
    expect(await prompt).toMatchObject({
      accepted: true,
      bytesWritten,
      prompt: { stages: ['input_accepted'] }
    })
    expect(await key).toBe(true)
    expect(onInputAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: true, bytesWritten })
    )
    expect(h.bytes.slice(1)).toEqual(['\r', 'key'])
  })

  it('holds prompt resubmit bytes and stops them for an explicit interrupt', async () => {
    const h = await harness('codex')
    const prompt = h.runtime.sendTerminalAgentPrompt(h.handle, 'prompt', {
      inputKind: 'driving',
      composerReady: true,
      acceptQueued: true,
      requestId: 'submitted-before-interrupt',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.bytes).toHaveLength(2)
    const b = h.send('B')
    await vi.advanceTimersByTimeAsync(0)
    const interrupt = h.desktop.writePtyInput({ id: PTY, data: '\x03', inputKind: 'driving' })
    await vi.runAllTimersAsync()
    expect(await prompt).toMatchObject({
      accepted: true,
      bytesWritten: Buffer.byteLength(h.bytes[0]) + 1,
      prompt: { stages: ['input_accepted'] }
    })
    await Promise.all([b, interrupt])
    expect(h.bytes.slice(1)).toEqual(['\r', '\x03', 'B', '\r'])
    expect(ptyInputTransactions.size).toBe(0)
  })
})
