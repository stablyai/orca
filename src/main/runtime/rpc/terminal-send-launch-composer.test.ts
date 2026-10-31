import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from '../agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-composer',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-composer',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

// Claude's palette-report anchor, then its composer prompt row (draft-paste-ready-scanner.ts).
const CLAUDE_COMPOSER_READY_OUTPUT = '\x1b[?2031h\x1b[?2004h❯\u00a0'
const PTY_ID = 'pty-claude'
// Claude 2.1.314's first-launch trust menu, captured from a real PTY.
const CLAUDE_TRUST_DIALOG_OUTPUT =
  '\x1b[?2004h Accessing workspace:\r\n\r\n /private/tmp/repro\r\n\r\n' +
  ' Quick safety check: Is this a project you created or one you trust?\r\n\r\n' +
  ' ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel\r\n'

async function launchClaude(command: string | undefined) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  runtime.setPtyController({
    spawn: async () => ({ id: PTY_ID }),
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'claude',
    ...(command ? { command } : {})
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const send = (text: string, signal?: AbortSignal) =>
    dispatcher.dispatch(
      {
        id: 'rpc-send',
        authToken: 'token',
        method: 'terminal.send',
        params: { terminal: handle, text, enter: true }
      },
      signal ? { signal } : undefined
    )
  return { runtime, writes, send }
}

const PASTE = '\x1b[200~/review\nthis\x1b[201~'

describe('terminal.send into a freshly launched Claude', () => {
  afterEach(() => vi.useRealTimers())

  // A command override keeps the planned agent, so its launch is held too.
  it.each(['claude', 'my-claude'])(
    'holds the submit until the composer is drawn (#34580, %s)',
    async (command) => {
      vi.useFakeTimers()
      const { runtime, writes, send } = await launchClaude(command)

      const sending = send(PASTE)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(writes).toEqual([])

      runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
      await vi.runAllTimersAsync()

      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(writes).toEqual([PASTE, '\r'])
    }
  )

  it('refuses the send, writing nothing, when the composer never comes up', async () => {
    vi.useFakeTimers()
    const { writes, send } = await launchClaude('claude')

    const sending = send(PASTE)
    await vi.runAllTimersAsync()

    await expect(sending).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(writes).toEqual([])
  })

  it('lets an answer reach a startup dialog shown before the composer', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await launchClaude('claude')

    const sending = send('1')
    runtime.onPtyData(PTY_ID, CLAUDE_TRUST_DIALOG_OUTPUT, Date.now())
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(sending).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(writes).toEqual(['1', '\r'])
  })

  it('writes nothing for a held send whose request was cancelled', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await launchClaude('claude')
    const request = new AbortController()

    const sending = send(PASTE, request.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    request.abort()
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.runAllTimersAsync()

    await sending
    expect(writes).toEqual([])
  })

  // A resume tab types its own `claude --resume`; a headless `--print` run never draws a composer.
  it.each([undefined, 'claude --print task'])(
    'does not hold sends to a shell tagged for Claude that starts no composer (%s)',
    async (command) => {
      const { writes, send } = await launchClaude(command)

      await expect(send('claude --resume abc')).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(writes).toEqual(['claude --resume abc', '\r'])
    }
  )
})
