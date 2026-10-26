import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { resolveAgentPromptSubmitDelayForAgent } from '../../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { writeRefused } from '../../../shared/pty-write-settlement'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_SEND_METHODS } from './methods/terminal/terminal-send-method'

vi.mock('../../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'test',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: async () => worktrees,
    listWorktreesStrict: async () => worktrees
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

async function createTerminal(agent: TuiAgent = 'claude') {
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, agent)
  vi.spyOn(runtime, 'getTerminalAgentStatus').mockImplementation(async () => ({
    handle,
    isRunningAgent: true,
    status: 'idle'
  }))
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_SEND_METHODS })
  const send = (input: { text?: string; enter?: boolean; requireAgentStatus?: 'sendable' }) =>
    dispatcher.dispatch({
      id: 'send-1',
      authToken: 'test-token',
      method: 'terminal.send',
      params: {
        terminal: handle,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' },
        ...input
      }
    })
  return {
    runtime,
    handle,
    writes,
    send
  }
}

describe('guarded annotation paste and submit', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    'acknowledges paste immediately with the %s execution host delay',
    async (platform) => {
      vi.useFakeTimers()
      const { writes, send } = await createTerminal()
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      const text = `\x1b[200~${'한글 annotation\n'.repeat(400)}\x1b[201~`
      const delay = resolveAgentPromptSubmitDelayForAgent(platform, text, 'claude')
      let acknowledged = false
      const paste = send({ text }).then((response) => {
        acknowledged = true
        return response
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(acknowledged).toBe(true)
      await expect(paste).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true, submitDelayMs: delay } }
      })
      expect(writes).toEqual([text])
      await vi.advanceTimersByTimeAsync(delay)
      const submit = await send({ enter: true })
      expect(submit).toMatchObject({ ok: true, result: { send: { accepted: true } } })
      expect(submit).toMatchObject({
        result: { send: expect.not.objectContaining({ submitDelayMs: expect.any(Number) }) }
      })
      expect(writes).toEqual([text, '\r'])
    }
  )

  it.each([
    { platform: 'win32', agent: 'claude', prompt: 'x'.repeat(1024 * 1024) },
    { platform: 'linux', agent: 'antigravity', prompt: 'feedback line\n'.repeat(400) }
  ] as const)(
    'acknowledges $agent paste on $platform within the RPC budget despite a delay over 15 seconds',
    async ({ platform, agent, prompt }) => {
      vi.useFakeTimers()
      const { writes, send } = await createTerminal(agent)
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      const text = `\x1b[200~${prompt}\x1b[201~`
      const delay = resolveAgentPromptSubmitDelayForAgent(platform, text, agent)
      expect(delay).toBeGreaterThan(15_000)
      let acknowledged = false
      const paste = send({ text }).then((response) => {
        acknowledged = true
        return response
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(acknowledged).toBe(true)
      await expect(paste).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true, submitDelayMs: delay } }
      })
      expect(writes.join('')).toBe(text)
    }
  )

  it('omits the submit delay on ordinary input and refused writes', async () => {
    const { runtime, handle, writes, send } = await createTerminal()
    const ordinary = await send({ text: 'typing', requireAgentStatus: undefined })
    expect(ordinary).toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(ordinary).toMatchObject({
      result: { send: expect.not.objectContaining({ submitDelayMs: expect.any(Number) }) }
    })
    runtime.setPtyController({
      write: () => false,
      writeWithSettlement: () => writeRefused('endpoint_disconnected'),
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const refused = await runtime.sendTerminal(
      handle,
      { text: 'feedback' },
      {
        inputKind: 'driving',
        includeSubmitDelay: true,
        requireWriteSettlement: true
      }
    )
    expect(refused.accepted).toBe(false)
    expect(refused).not.toHaveProperty('submitDelayMs')
    expect(writes).toEqual(['typing'])
  })

  it('also supplies the delay for a restored leaf without a tracked PTY', async () => {
    const runtime = new OrcaRuntimeService()
    const writes: string[] = []
    runtime.setPtyController({
      write: (_id, text) => {
        writes.push(text)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'folder-1',
          title: 'Claude',
          activeLeafId: 'pane-1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'folder-1',
          leafId: 'pane-1',
          paneRuntimeId: 1,
          ptyId: 'pty-restored',
          paneTitle: 'Claude'
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const text = '\x1b[200~Browser feedback\x1b[201~'
    const result = await runtime.sendTerminal(
      terminal.handle,
      { text },
      {
        inputKind: 'driving',
        includeSubmitDelay: true
      }
    )
    expect(result).toMatchObject({
      accepted: true,
      submitDelayMs: resolveAgentPromptSubmitDelayForAgent(process.platform, text, null)
    })
    expect(writes).toEqual([text])
  })
})
