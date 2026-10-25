import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../orchestration/db'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/pi',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/pi',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

async function createHarness(negotiated = true, launchAgent: TuiAgent = 'pi') {
  const created = await createAgentPromptSubmissionRuntime(() => undefined, launchAgent)
  const controls: {
    foreground: string | null
    onWrite?: (data: string) => void
    onConfirm?: () => void
  } = { foreground: 'pi' }
  const confirmForegroundProcess = vi.fn(async () => {
    controls.onConfirm?.()
    return controls.foreground
  })
  created.runtime.setPtyController({
    write: (_id, data) => {
      created.writes.push(data)
      controls.onWrite?.(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'pi',
    confirmForegroundProcess
  })
  if (negotiated) {
    created.runtime.onPtyData('pty-prompt', '\x1b[?2004h', Date.now())
  }
  const db = new OrchestrationDb(':memory:')
  created.runtime.setOrchestrationDb(db)
  const dispatcher = new RpcDispatcher({ runtime: created.runtime, methods: TERMINAL_METHODS })
  let sequence = 0
  const send = (
    text: string,
    signal?: AbortSignal,
    overrides: Record<string, unknown> = {},
    durable = true
  ) => {
    sequence += 1
    return dispatcher.dispatch(
      {
        id: `pi-send-${sequence}`,
        authToken: 'token',
        method: 'terminal.send',
        ...(durable ? { orchestrationRequestId: `pi-send-${sequence}` } : {}),
        params: {
          terminal: created.handle,
          text,
          enter: true,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' },
          ...overrides
        }
      },
      { signal }
    )
  }
  return { ...created, controls, confirmForegroundProcess, db, send }
}

const prompt = 'check issue #12 please。'
const paste = `\x1b[200~${prompt}\x1b[201~`

describe('Pi terminal prompt framing', () => {
  afterEach(() => vi.useRealTimers())

  it('frames negotiated Pi input without claiming a proven turn or adding a rescue Enter', async () => {
    vi.useFakeTimers()
    const h = await createHarness()
    try {
      const pending = h.send(prompt)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({
        ok: true,
        result: {
          send: {
            accepted: true,
            prompt: {
              provider: 'unsupported',
              observation: 'unsupported',
              stages: ['input_accepted']
            }
          }
        }
      })
      expect(h.writes).toEqual([paste, '\r'])
      expect(h.confirmForegroundProcess.mock.calls.length).toBe(3)
    } finally {
      h.db.close()
    }
  })

  it('does not inherit supported turn observation from a different launch provider', async () => {
    vi.useFakeTimers()
    const h = await createHarness(true, 'codex')
    try {
      const pending = h.send(prompt)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({
        ok: true,
        result: { send: { prompt: { provider: 'unsupported', observation: 'unsupported' } } }
      })
      expect(h.writes).toEqual([prompt, '\r'])
    } finally {
      h.db.close()
    }
  })

  it.each(['bash', 'agent', null])(
    'preserves raw delivery when fresh foreground is %s despite Pi launch metadata',
    async (foreground) => {
      vi.useFakeTimers()
      const h = await createHarness()
      try {
        h.controls.foreground = foreground
        const pending = h.send(prompt)
        await vi.runAllTimersAsync()
        const response = await pending
        expect(response.ok, JSON.stringify(response)).toBe(true)
        expect(h.writes).toEqual([prompt, '\r'])
      } finally {
        h.db.close()
      }
    }
  )

  it('keeps the direct contract when bracketed paste was not negotiated', async () => {
    vi.useFakeTimers()
    const h = await createHarness(false)
    try {
      const pending = h.send(prompt)
      await vi.runAllTimersAsync()
      const response = await pending
      expect(response.ok, JSON.stringify(response)).toBe(true)
      expect(h.writes).toEqual([prompt, '\r'])
    } finally {
      h.db.close()
    }
  })

  it.each(['confirmation', 'restored-mode'] as const)(
    'retains raw delivery without authoritative %s capability',
    async (missing) => {
      vi.useFakeTimers()
      const h = await createHarness()
      try {
        if (missing === 'confirmation') {
          h.runtime.setPtyController({
            write: (_id, data) => {
              h.writes.push(data)
              return true
            },
            kill: () => true,
            getForegroundProcess: async () => 'pi'
          })
        } else {
          h.runtime.seedHeadlessTerminal('pty-prompt', 'history', undefined, {
            preferProviderIfExisting: true
          })
        }
        const pending = h.send(prompt)
        await vi.runAllTimersAsync()
        const response = await pending
        expect(response.ok, JSON.stringify(response)).toBe(true)
        expect(h.writes).toEqual([prompt, '\r'])
      } finally {
        h.db.close()
      }
    }
  )

  it.each(['shell', 'mode', 'abort', 'exit'] as const)(
    'does not submit or resend after %s changes following the paste',
    async (change) => {
      vi.useFakeTimers()
      const h = await createHarness()
      const controller = new AbortController()
      try {
        h.controls.onWrite = (data) => {
          if (data !== paste) {
            return
          }
          if (change === 'shell') {
            h.controls.foreground = 'bash'
          }
          if (change === 'mode') {
            h.runtime.onPtyData('pty-prompt', '\x1b[?2004l', Date.now())
          }
          if (change === 'abort') {
            controller.abort()
          }
          if (change === 'exit') {
            h.runtime.onPtyExit('pty-prompt', 0)
          }
        }
        const pending = h.send(prompt, controller.signal)
        await vi.runAllTimersAsync()
        const message =
          change === 'abort'
            ? 'request_aborted'
            : change === 'exit'
              ? 'terminal_handle_stale'
              : 'agent_not_in_foreground'
        expect(await pending).toMatchObject({ ok: false, error: { message } })
        expect(h.writes).toEqual([paste])
      } finally {
        h.db.close()
      }
    }
  )

  it('observes paste-mode output received during foreground confirmation before writing', async () => {
    vi.useFakeTimers()
    const h = await createHarness()
    try {
      h.controls.onConfirm = () => {
        if (h.confirmForegroundProcess.mock.calls.length === 2) {
          h.runtime.onPtyData('pty-prompt', '\x1b[?2004l', Date.now())
        }
      }
      const pending = h.send(prompt)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({
        ok: false,
        error: { message: 'agent_not_in_foreground' }
      })
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('refuses a process incarnation replaced during foreground confirmation', async () => {
    vi.useFakeTimers()
    const h = await createHarness()
    try {
      const binding = h.runtime.getTerminalPromptRequestBinding(h.handle)
      h.controls.onConfirm = () => {
        vi.spyOn(h.runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
          ...binding,
          processIncarnation: 'replacement'
        })
      }
      const pending = h.send(prompt)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({
        ok: false,
        error: { message: 'terminal_handle_stale' }
      })
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it.each(['/path', '.relative', '~home', 'control\tinput', 'control\rinput', '\x1b[200~literal'])(
    'preserves raw bytes for %j',
    async (text) => {
      vi.useFakeTimers()
      const h = await createHarness()
      try {
        const pending = h.send(text)
        await vi.runAllTimersAsync()
        const response = await pending
        expect(response.ok, JSON.stringify(response)).toBe(true)
        expect(h.writes).toEqual([text, '\r'])
        expect(h.confirmForegroundProcess).not.toHaveBeenCalled()
      } finally {
        h.db.close()
      }
    }
  )

  it.each([{ enter: false }, { agentPrompt: undefined }, {}])(
    'preserves direct input for %j',
    async (overrides) => {
      vi.useFakeTimers()
      const h = await createHarness()
      try {
        const pending = h.send(prompt, undefined, overrides, false)
        await vi.runAllTimersAsync()
        const response = await pending
        expect(response.ok, JSON.stringify(response)).toBe(true)
        expect(h.writes).toEqual(overrides.enter === false ? [prompt] : [prompt, '\r'])
        expect(h.confirmForegroundProcess).not.toHaveBeenCalled()
      } finally {
        h.db.close()
      }
    }
  )
})
