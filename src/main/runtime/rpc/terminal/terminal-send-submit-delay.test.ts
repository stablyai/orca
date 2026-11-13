import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
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
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/submit-delay',
      isBare: false,
      isMainWorktree: false
    }
  ]
  const listings = {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
  return { getWorktreeListingMocks: () => listings }
})

const PASTE = '\x1b[200~short note\x1b[201~'

async function launch(agent: 'claude' | null) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  const afterWrite: { current?: () => void } = {}
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-1' }),
    write: (ptyId: string, data: string) => {
      // The app's controller records every input before it writes it.
      runtime.terminalRunFacts.recordInput(ptyId, 'driving', data)
      writes.push(data)
      afterWrite.current?.()
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => agent ?? 'zsh'
  })
  const { handle } = await runtime.createTerminal(
    `path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`,
    agent ? { launchAgent: agent } : {}
  )
  if (agent) {
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  }
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const send = async (params: Record<string, unknown>) => {
    const response = await dispatcher.dispatch({
      id: 'rpc-send',
      authToken: 'token',
      method: 'terminal.send',
      params: { terminal: handle, ...params }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return z.object({ send: z.record(z.string(), z.unknown()) }).parse(response.result).send
  }
  const statusInputGeneration = async (): Promise<unknown> => {
    const response = await dispatcher.dispatch({
      id: 'rpc-status',
      authToken: 'token',
      method: 'terminal.agentStatus',
      params: { terminal: handle }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return z.object({ inputGeneration: z.unknown() }).parse(response.result).inputGeneration
  }
  /** Input from anyone else: the keyboard, another client. */
  const type = (data: string): void => {
    runtime.terminalRunFacts.recordInput('pty-1', 'driving', data)
    writes.push(data)
  }
  return { writes, send, type, afterWrite, statusInputGeneration }
}

describe('terminal.send submit delay for a guarded paste', () => {
  afterEach(() => vi.useRealTimers())

  it('names no wait for a refused guarded paste', async () => {
    vi.useFakeTimers()
    const { writes, send } = await launch(null)
    const pending = send({ text: PASTE, requireAgentStatus: 'sendable' })
    await vi.advanceTimersByTimeAsync(5_000)
    const receipt = await pending
    expect(receipt).toMatchObject({ accepted: false, refusedReason: 'no-agent' })
    expect(receipt).not.toHaveProperty('submitDelayMs')
    expect(writes).toEqual([])
  })

  it('names no wait for an unguarded text send', async () => {
    const { send } = await launch('claude')
    const receipt = await send({ text: PASTE })
    expect(receipt).toMatchObject({ accepted: true })
    expect(receipt).not.toHaveProperty('submitDelayMs')
  })
})

describe('terminal.agentStatus after a guarded paste', () => {
  it('names the paste as the last input until the terminal takes other input', async () => {
    const { send, type, statusInputGeneration } = await launch('claude')
    const paste = await send({ text: PASTE, requireAgentStatus: 'sendable' })
    expect(typeof paste.inputGeneration).toBe('number')
    expect(await statusInputGeneration()).toBe(paste.inputGeneration)
    type('x')
    expect(await statusInputGeneration()).not.toBe(paste.inputGeneration)
  })
})

describe('terminal.send guarded Enter for one paste', () => {
  it('presses Enter only while the paste is still the last input', async () => {
    const { writes, send, type } = await launch('claude')
    const enterFor = (paste: Record<string, unknown>) =>
      send({
        enter: true,
        requireAgentStatus: 'sendable',
        expectInputGeneration: paste.inputGeneration
      })
    const untouched = await send({ text: PASTE, requireAgentStatus: 'sendable' })
    expect(await enterFor(untouched)).toMatchObject({ accepted: true })
    expect(writes).toEqual([PASTE, '\r'])

    const typedOver = await send({ text: PASTE, requireAgentStatus: 'sendable' })
    type('x')
    expect(await enterFor(typedOver)).toMatchObject({
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'input-changed'
    })
    expect(writes).toEqual([PASTE, '\r', PASTE, 'x'])
  })

  it('refuses the Enter when input landed between two chunks of the paste', async () => {
    const { writes, send, type, afterWrite } = await launch('claude')
    // Two 16 KiB chunks; the keystroke arrives once the first is written.
    const text = `\x1b[200~${'x'.repeat(20_000)}\x1b[201~`
    afterWrite.current = () => {
      if (writes.length === 1) {
        queueMicrotask(() => type('x'))
      }
    }
    const paste = await send({ text, requireAgentStatus: 'sendable' })
    const receipt = await send({
      enter: true,
      requireAgentStatus: 'sendable',
      expectInputGeneration: paste.inputGeneration
    })
    expect(receipt).toMatchObject({ accepted: false, bytesWritten: 0 })
    expect(writes.filter((data) => data !== 'x').join('')).toBe(text)
  })

  it('never writes the Enter after input that arrived at any point while it was being sent', async () => {
    const { writes, send, type } = await launch('claude')
    const outcomes = new Set<string>()
    // The keystroke lands after `turns` macrotasks and then `ticks` microtasks of the Enter's send.
    for (let turns = 0; turns < 3; turns += 1) {
      for (let ticks = 0; ticks < 120; ticks += 1) {
        writes.length = 0
        const paste = await send({ text: PASTE, requireAgentStatus: 'sendable' })
        const typed = (async () => {
          for (let turn = 0; turn < turns; turn += 1) {
            await new Promise((resolve) => setImmediate(resolve))
          }
          for (let tick = 0; tick < ticks; tick += 1) {
            await Promise.resolve()
          }
          type('x')
        })()
        const receipt = await send({
          enter: true,
          requireAgentStatus: 'sendable',
          expectInputGeneration: paste.inputGeneration
        })
        await typed
        const order = writes.join('')
        outcomes.add(order)
        expect(receipt.accepted).toBe(order === `${PASTE}\rx`)
      }
    }
    // Input before the Enter refuses it; input after it is too late to matter. Nothing in between.
    expect([...outcomes].sort()).toEqual([`${PASTE}\rx`, `${PASTE}x`].sort())
  })
})
