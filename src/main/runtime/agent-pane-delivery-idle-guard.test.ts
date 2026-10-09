// The idle half of the send guard: "deliver when the agent is free" is only worth
// anything if the last look at the agent happens at the write. Everything before
// it — the scheduled-message settle timer, the settled-prompt probe here — is
// seconds old, and the user can type in that window.
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { sendGuardedAgentPrompt } from './agent-pane-delivery'

const HANDLE = 'handle-1'

type BeforeWriteOptions = { beforeWrite: () => Promise<void> }

function makeRuntime(options: { status: 'working' | 'idle'; startsWorkingAtProbe?: boolean }) {
  const written: string[] = []
  const state = { status: options.status }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads three runtime methods; constructing a real OrcaRuntimeService here would need a live PTY to say anything about the agent's status.
  const runtime = {
    getTerminalAgentStatus: vi.fn(() =>
      Promise.resolve({ handle: HANDLE, isRunningAgent: true, status: state.status })
    ),
    isTerminalRunningSettledPromptAgent: vi.fn(() => {
      // The probe is the slow step the agent can wake up inside.
      if (options.startsWorkingAtProbe === true) {
        state.status = 'working'
      }
      return Promise.resolve(true)
    }),
    sendTerminalAgentPrompt: vi.fn(async (_h: string, text: string, opts: BeforeWriteOptions) => {
      await opts.beforeWrite()
      written.push(text)
    })
  } as unknown as OrcaRuntimeService
  return { runtime, written }
}

describe('sendGuardedAgentPrompt stillWanted', () => {
  it('withdraws the text when the sender loses interest during the probe', async () => {
    // The scheduled-message row can be rewritten or deleted while the settled-prompt
    // probe runs, and the captured text would otherwise reach the agent anyway.
    const { runtime, written } = makeRuntime({ status: 'idle' })

    await expect(
      sendGuardedAgentPrompt(runtime, HANDLE, 'typo', { stillWanted: () => false })
    ).rejects.toThrow('terminal_send_superseded')
    expect(written).toEqual([])
  })

  it('writes when the sender still wants it', async () => {
    const { runtime, written } = makeRuntime({ status: 'idle' })

    await sendGuardedAgentPrompt(runtime, HANDLE, 'fixed', { stillWanted: () => true })
    expect(written).toEqual(['fixed'])
  })
})

describe('sendGuardedAgentPrompt requireIdleAgent', () => {
  it('refuses at the write when the agent picked work back up after the first check', async () => {
    const { runtime, written } = makeRuntime({ status: 'idle', startsWorkingAtProbe: true })

    await expect(
      sendGuardedAgentPrompt(runtime, HANDLE, 'when free', { requireIdleAgent: true })
    ).rejects.toThrow('terminal_guard_agent_busy')
    expect(written).toEqual([])
  })

  it('delivers to an agent that is still idle at the write', async () => {
    const { runtime, written } = makeRuntime({ status: 'idle' })

    await sendGuardedAgentPrompt(runtime, HANDLE, 'when free', { requireIdleAgent: true })
    expect(written).toEqual(['when free'])
  })

  it('leaves a working agent alone only when idleness was asked for', async () => {
    // A clock-timed message said nothing about the agent being free, and a user
    // pressing Enter in a busy pane is an interruption they chose.
    const { runtime, written } = makeRuntime({ status: 'working' })

    await sendGuardedAgentPrompt(runtime, HANDLE, 'at 5pm')
    expect(written).toEqual(['at 5pm'])
  })
})
