import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'

// Why: the prompt fixture creates a real terminal in a worktree the store must be able to list.
const worktrees = [
  {
    path: AGENT_PROMPT_TEST_WORKTREE_PATH,
    head: 'abc',
    branch: 'feature/prompt-verification',
    isBare: false,
    isMainWorktree: false
  }
]
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn(async () => worktrees),
  listWorktreesStrict: vi.fn(async () => worktrees)
}))

const LAPTOP = { pairedDeviceId: 'device-laptop', clientKind: 'runtime' as const }
const PHONE = { pairedDeviceId: 'device-phone', clientKind: 'mobile' as const }

function makeRuntime() {
  return new OrcaRuntimeService(makeStore() as never)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function mockSendTerminalWriting(ptyId: string) {
  vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminal').mockImplementation(
    async (handle, _action, options = {}) => {
      await options.afterWrite?.(ptyId)
      return { handle, accepted: true, bytesWritten: 2 }
    }
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

// Why these tests: the record is stored after a send's whole write resolved, so two sends into
// one PTY can finish in the opposite order from the one the PTY saw. "Last input" has to mean
// the last write the PTY accepted, not the last RPC call that happened to return.
describe('OrcaRuntimeService terminal input source keeps PTY write order', () => {
  it('drops a record whose write sequence is older than the stored one', () => {
    const runtime = makeRuntime()
    const first = runtime.nextTerminalWriteSequence()
    const second = runtime.nextTerminalWriteSequence()

    runtime.recordTerminalInputSource('pty-1', PHONE, second)
    runtime.recordTerminalInputSource('pty-1', LAPTOP, first)

    expect(runtime.getTerminalInputSource('pty-1')).toMatchObject({
      pairedDeviceId: 'device-phone'
    })
    expect(runtime.getTerminalInputSource('pty-1')).not.toHaveProperty('sequence')
  })

  it('keeps the later write when the earlier send resolves last', async () => {
    const runtime = makeRuntime()
    const writer = new RuntimeTerminalWriter(() => true)
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminal').mockImplementation(
      async (handle, action, options = {}) => {
        await writer.writeAction('pty-real', action, action.text ?? '', options)
        return { handle, accepted: true, bytesWritten: action.text?.length ?? 0 }
      }
    )
    // Why a slow afterWrite: it is the caller-supplied step the writer awaits between the last
    // accepted PTY write and the point where the override records.
    const laptopAfterWrite = deferred()
    const laptop = runtime.sendTerminal(
      'term-1',
      { text: 'from laptop' },
      { afterWrite: () => laptopAfterWrite.promise, inputSource: LAPTOP }
    )
    await runtime.sendTerminal('term-1', { text: 'from phone' }, { inputSource: PHONE })
    expect(runtime.getTerminalInputSource('pty-real')).toMatchObject({
      pairedDeviceId: 'device-phone'
    })

    laptopAfterWrite.resolve()
    await laptop

    expect(runtime.getTerminalInputSource('pty-real')).toMatchObject({
      pairedDeviceId: 'device-phone'
    })
  })

  // Why two prompt cases: the override records from whichever of the accepted receipt and the
  // onInputAccepted checkpoint comes first, and either can arrive after a newer send.
  it('keeps a later send over an agent prompt whose accepted receipt returns after it', async () => {
    const runtime = makeRuntime()
    const verification = deferred()
    const promptWritten = deferred()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options = {}) => {
        await options.afterWrite?.('pty-prompt')
        promptWritten.resolve()
        await verification.promise
        return { handle, accepted: true, bytesWritten: 6 }
      }
    )
    mockSendTerminalWriting('pty-prompt')

    const prompt = runtime.sendTerminalAgentPrompt('term-1', 'hello', { inputSource: LAPTOP })
    await promptWritten.promise
    expect(runtime.getTerminalInputSource('pty-prompt')).toBeNull()

    await runtime.sendTerminal('term-1', { text: 'ls' }, { inputSource: PHONE })
    verification.resolve()
    await prompt

    expect(runtime.getTerminalInputSource('pty-prompt')).toMatchObject({
      pairedDeviceId: 'device-phone'
    })
  })

  it('keeps a later send over an agent prompt whose onInputAccepted checkpoint fires after it', async () => {
    const runtime = makeRuntime()
    const checkpointGate = deferred()
    const promptWritten = deferred()
    vi.spyOn(OrcaRuntimeWithResolveWaiter.prototype, 'sendTerminalAgentPrompt').mockImplementation(
      async (handle, _prompt, options = {}) => {
        await options.afterWrite?.('pty-prompt')
        promptWritten.resolve()
        await checkpointGate.promise
        options.onInputAccepted?.({ handle, accepted: true, bytesWritten: 6 })
        throw new Error('agent_prompt_observation_aborted')
      }
    )
    mockSendTerminalWriting('pty-prompt')

    const prompt = runtime.sendTerminalAgentPrompt('term-1', 'hello', {
      acceptQueued: true,
      requestId: 'req-1',
      inputSource: LAPTOP
    })
    await promptWritten.promise

    await runtime.sendTerminal('term-1', { text: 'ls' }, { inputSource: PHONE })
    checkpointGate.resolve()
    await expect(prompt).rejects.toThrow('agent_prompt_observation_aborted')

    expect(runtime.getTerminalInputSource('pty-prompt')).toMatchObject({
      pairedDeviceId: 'device-phone'
    })
  })
})

describe('writeTerminalAgentPrompt fires afterWrite', () => {
  it('after the paste and again after the submit, each once the PTY accepted the bytes', async () => {
    const seen: { ptyId: string; writes: number }[] = []
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)

    await runtime.sendTerminalAgentPrompt(handle, 'hello', {
      acceptQueued: true,
      requestId: 'req-1',
      afterWrite: (ptyId) => {
        seen.push({ ptyId, writes: writes.length })
      }
    })

    expect(writes.at(-1)).toBe(AGENT_PROMPT_SUBMIT)
    expect(seen).toEqual([
      { ptyId: 'pty-prompt', writes: 1 },
      { ptyId: 'pty-prompt', writes: 2 }
    ])
  })
})
