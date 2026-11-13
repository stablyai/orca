import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { settledWriteStub } from '../../../providers/testing/settled-pty-write-stub'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeStore } from '../server/runtime-rpc-worktree-store-fixtures'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from '../../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
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
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

// Claude's palette-report anchor, then its composer prompt row (draft-paste-ready-scanner.ts).
const CLAUDE_COMPOSER_READY_OUTPUT = '\x1b[?2031h\x1b[?2004h❯\u00a0'
const PTY_ID = 'pty-claude'

async function launchClaude(command: string | undefined, ordered = false) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  const write = (_ptyId: string, data: string) => {
    writes.push(data)
    return true
  }
  runtime.setPtyController({
    spawn: async () => ({ id: PTY_ID }),
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'claude',
    ...(command ? { command } : {})
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const mobile = {
    caller: { kind: 'paired-device', deviceId: 'device' },
    clientId: 'phone'
  } as const
  const client = { id: 'phone', type: 'mobile' } as const
  let inputSessionId: string | undefined
  let seq = 0
  if (ordered) {
    await runtime.handleMobileSubscribe(PTY_ID, 'phone', undefined)
    const opened = await dispatcher.dispatch(
      {
        id: 'open',
        authToken: 'token',
        method: 'terminal.openInputSession',
        params: { terminal: handle, client }
      },
      mobile
    )
    if (!opened.ok) {
      throw new Error(opened.error.message)
    }
    inputSessionId = z.object({ inputSessionId: z.string() }).parse(opened.result).inputSessionId
  }
  const send = (text: string, signal?: AbortSignal) =>
    dispatcher.dispatch(
      {
        id: 'rpc-send',
        authToken: 'token',
        method: 'terminal.send',
        params: {
          terminal: handle,
          text,
          enter: true,
          ...(inputSessionId
            ? { client, inputSequence: { sessionId: inputSessionId, seq: ++seq } }
            : {})
        }
      },
      { ...(ordered ? mobile : {}), ...(signal ? { signal } : {}) }
    )
  return { runtime, writes, send }
}

const PASTE = '\x1b[200~/review\nthis\x1b[201~'

describe('terminal.send into a freshly launched Claude', () => {
  afterEach(() => vi.useRealTimers())

  it('holds the entire ordered suffix behind the fresh composer and the first submit', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await launchClaude('claude', true)
    const first = send(PASTE)
    const second = send('next')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(writes).toEqual([])
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.runAllTimersAsync()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ result: { send: expect.objectContaining({ accepted: true }) } }),
      expect.objectContaining({ result: { send: expect.objectContaining({ accepted: true }) } })
    ])
    expect(writes).toEqual([PASTE, '\r', 'next', '\r'])
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
})
