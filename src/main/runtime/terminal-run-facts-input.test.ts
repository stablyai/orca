import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import { sendTerminalStreamInput } from './rpc/methods/terminal/terminal-input-delivery'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/run-facts',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const PTY_ID = 'pty-prompt'

/** A fresh shell, and whether it had recorded user input by the time each write reached it. */
async function createFreshRun(): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  inputRecordedAtWrite: boolean[]
  firstUserInputAt: () => number | null
}> {
  const inputRecordedAtWrite: boolean[] = []
  const { runtime, handle } = await createAgentPromptSubmissionRuntime((current, data) => {
    inputRecordedAtWrite.push(current.terminalRunFacts.read(PTY_ID, null).firstUserInputAt !== null)
    if (data === '\r') {
      current.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now())
    }
  })
  runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
  return {
    runtime,
    handle,
    inputRecordedAtWrite,
    firstUserInputAt: () => runtime.terminalRunFacts.read(PTY_ID, null).firstUserInputAt
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('run facts: input from clients other than the local renderer', () => {
  it('records terminal.send input before the write that could end the process', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: 'exit', enter: true })

    expect(run.firstUserInputAt()).not.toBeNull()
    expect(run.inputRecordedAtWrite).toEqual([true, true])
  })

  it('records stream input', async () => {
    const run = await createFreshRun()

    await sendTerminalStreamInput(run.runtime, {
      terminal: run.handle,
      text: 'l',
      client: undefined,
      isMobile: false
    })

    expect(run.firstUserInputAt()).not.toBeNull()
  })

  it('records a dispatched agent prompt', async () => {
    vi.useFakeTimers()
    const run = await createFreshRun()

    const submission = run.runtime.sendTerminalAgentPrompt(run.handle, 'review this')
    await vi.runAllTimersAsync()
    await submission.catch(() => undefined)

    expect(run.firstUserInputAt()).not.toBeNull()
    expect(run.inputRecordedAtWrite[0]).toBe(true)
  })

  it('records nothing for a reply sent as a query reply', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: 'y' }, { inputKind: 'query-reply' })

    expect(run.firstUserInputAt()).toBeNull()
  })

  it('records nothing for a payload that is only a terminal reply', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: '\x1b[3;4R' })

    expect(run.firstUserInputAt()).toBeNull()
  })

  it('records a reply mixed with a keystroke', async () => {
    const run = await createFreshRun()

    await run.runtime.sendTerminal(run.handle, { text: '\x1b[3;4Rx' })

    expect(run.firstUserInputAt()).not.toBeNull()
  })
})
