import '../unused-default-rpc-methods.test-fixture'
import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
/** A closed composer proves no write; stalled submission proves text was written despite unobserved progress. Receipts must distinguish them to avoid duplicate turns. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AGENT_PROMPT_STALLED_ERROR } from '../../terminal/input/agent-prompt-submission-verification'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { tokenizeStartupCommand } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { createAgentPromptSubmissionRuntime } from '../../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { openTestAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { setAgentLaunchRecordStore } from './agent-launch.test-fixture'

const createStructured = vi.hoisted(() =>
  vi.fn(
    async (args: {
      envelope: { sessionId: string }
      firstMessage?: { clientMessageId: string }
    }): Promise<unknown> => ({
      ok: true as const,
      value: { sessionId: args.envelope.sessionId, fence: 1, firstMessage: args.firstMessage }
    })
  )
)
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn(async () => WORKTREES)
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn(async () => WORKTREES)
}))

const { WORKTREES } = vi.hoisted(() => ({
  WORKTREES: [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]
}))

const {
  MESSAGE_ID,
  hostRuntime,
  operationId,
  prepare,
  prepared,
  release,
  status,
  untilAwaitingRelease
} = await import('./agent-launch-release.test-fixture')

type SendResult = { handle: string; accepted: boolean; bytesWritten: number }
type SendFn = (
  handle: string,
  text: string,
  options: Record<string, unknown>
) => Promise<SendResult>

const COMPOSER_READY = { satisfied: true, status: 'running' }

function runtimeStub(overrides: {
  wait?: unknown
  waits?: unknown[]
  send?: SendFn
  /** Whether the agent's composer signal fires within its budget; else the idle evidence decides. */
  composerSignal?: boolean
  /** What a fresh read finds in the terminal's foreground; default: the agent. */
  foreground?: 'agent' | 'shell' | 'unknown'
  /** False on a host that cannot find the agent in front (Windows); default: it can. */
  hostProvesAgent?: boolean
  /** True on a local non-WSL Windows pane, whose lone shell is provable; default: not. */
  hostProvesShellAlone?: boolean
}) {
  const queued = [...(overrides.waits ?? [])]
  const waitForTerminal = vi.fn(
    async (_handle: string, _options?: { condition?: string; timeoutMs?: number }) =>
      queued.shift() ?? overrides.wait ?? { satisfied: true, status: 'idle' }
  )
  const waitForFreshWorkerComposer = vi.fn(async () => {
    if (!overrides.composerSignal) {
      throw new Error('timeout')
    }
    return COMPOSER_READY
  })
  const readLaunchedAgentForeground = vi.fn(async () => overrides.foreground ?? 'agent')
  const subscribeToTerminalData = vi.fn(() => () => {})
  const launchedAgentHostProvesAgent = vi.fn(() => overrides.hostProvesAgent ?? true)
  const launchedAgentHostProvesShellAlone = vi.fn(() => overrides.hostProvesShellAlone ?? false)
  const sendTerminalAgentPrompt = vi.fn<SendFn>(
    overrides.send ?? (async () => ({ handle: 'term_1', accepted: true, bytesWritten: 12 }))
  )
  return {
    waitForTerminal,
    waitForFreshWorkerComposer,
    sendTerminalAgentPrompt,
    readLaunchedAgentForeground,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches exactly these six runtime methods; anything else would throw rather than read a wrong value.
    runtime: {
      waitForTerminal,
      waitForFreshWorkerComposer,
      sendTerminalAgentPrompt,
      readLaunchedAgentForeground,
      subscribeToTerminalData,
      launchedAgentHostProvesAgent,
      launchedAgentHostProvesShellAlone
    } as unknown as Parameters<typeof deliverTerminalAgentLaunchPrompt>[0]['runtime']
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('writing a launch prompt into a terminal agent', () => {
  it('waits for the composer before writing, and reports the write', async () => {
    const stub = runtimeStub({})
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true
    })
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: expect.any(Number),
      // A name-only title proves nothing about a just-launched agent until its stream is quiet.
      launchReadiness: true
    })
    const [handle, text, options] = stub.sendTerminalAgentPrompt.mock.calls[0]!
    expect(handle).toBe('term_1')
    expect(text).toBe('do the thing')
    // acceptQueued and requestId together settle unobserved progress as input_accepted; strict verification would invite resending existing text.
    expect(options.acceptQueued).toBe(true)
    expect(options.requestId).toEqual(expect.any(String))
    expect(options.composerReady).toBe(true)
  })

  it('does not write when the composer never opened', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'blocked' } })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    // A trust or update prompt is on screen; the text would answer whatever it asked.
    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports a stalled submission as delivered, because the stall is raised after the write', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error(AGENT_PROMPT_STALLED_ERROR)
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
  })

  it('under-claims when the write itself failed', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error('terminal_not_writable')
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('does not fail the launch when the readiness wait throws', async () => {
    const stub = runtimeStub({})
    stub.waitForTerminal.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('writes nothing for blank text', async () => {
    const stub = runtimeStub({})
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: true,
        text: '   '
      })
    ).toBe(false)
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('waits out a blocking prompt the user dismisses, then writes', async () => {
    const blocked = { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    const stub = runtimeStub({ waits: [blocked, blocked, { satisfied: true, status: 'running' }] })
    const clock = fakeClock()

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock
    })

    expect(delivered).toBe(true)
    expect(stub.waitForTerminal).toHaveBeenCalledTimes(3)
    // Each re-wait spends only what is left of the one launch budget.
    const lastTimeoutMs = stub.waitForTerminal.mock.calls.at(-1)?.[1]?.timeoutMs ?? 0
    expect(lastTimeoutMs).toBeLessThanOrEqual(58_000)
    expect(lastTimeoutMs).toBeGreaterThan(57_000)
    expect(stub.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
  })

  it('writes nothing into a blocking prompt still up when the budget ends', async () => {
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: fakeClock()
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    // One check per second of a 60 s budget, then it stops rather than spinning.
    expect(stub.waitForTerminal.mock.calls.length).toBeLessThanOrEqual(60)
  })

  it.each([
    ['writes when a fresh read finds the agent in front', 'agent', true],
    ['refuses the write when the shell is back in front', 'shell', false],
    // A ready signal can be a shell's own prompt, so a read that cannot tell proves nothing.
    ['refuses the write when the host cannot tell what is in front', 'unknown', false]
  ] as const)('%s', async (_label, foreground, delivered) => {
    // An agent that exits at startup hands its shell back, which must never run the prompt.
    const stub = runtimeStub({ composerSignal: true, foreground })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: true,
        text: 'do the thing'
      })
    ).resolves.toBe(delivered)
    expect(stub.readLaunchedAgentForeground).toHaveBeenCalledWith('pty-1', 'claude')
  })

  it('checks the foreground once for the paste, its Enter and the second Enter', async () => {
    const stub = runtimeStub({ composerSignal: true })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
        await beforeWrite('pty-1')
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'codex',
        freshLaunch: true,
        text: 'do the thing'
      })
    ).resolves.toBe(true)
    expect(stub.readLaunchedAgentForeground).toHaveBeenCalledTimes(1)
  })

  it('writes as soon as the composer signal fires, without consulting the idle evidence', async () => {
    const stub = runtimeStub({ composerSignal: true })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true
    })
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
  })

  it.each(['zcode', 'opencode', 'opencode2'] as const)(
    'waits for %s’s composer readiness',
    async (agent) => {
      const stub = runtimeStub({ composerSignal: true })

      const delivered = await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent,
        freshLaunch: true,
        text: 'do the thing',
        clock: fakeClock()
      })

      expect(delivered).toBe(true)
      expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', agent, 60_000)
      expect(stub.waitForTerminal).not.toHaveBeenCalled()
    }
  )

  it('keeps the text when an agent shows no readiness evidence at all', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'running' } })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'goose',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('never lets a re-wait fall back to the terminal wait’s 5-minute default', async () => {
    // A late 1 s re-check sleep can land past the deadline; 0 would read as "use the default".
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })
    let now = 0
    const lateClock = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms + 1_000
      }
    }

    await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: lateClock
    })

    for (const [, options] of stub.waitForTerminal.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0)
    }
  })

  it('waits on a reused terminal’s idle state, not a fresh launch’s composer marker', async () => {
    // A long-running grok pane may no longer show its composer marker in recent output.
    const stub = runtimeStub({})

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_existing',
      agent: 'grok',
      freshLaunch: false,
      text: 'do the thing',
      clock: fakeClock()
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_existing', {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    // A reused pane's render state is only inferred, so its Enter still waits for the render.
    expect(stub.sendTerminalAgentPrompt.mock.calls[0]?.[2]?.composerReady).toBe(false)
  })

  it('writes nothing into a reused terminal whose agent is no longer in front', async () => {
    const stub = runtimeStub({ foreground: 'shell' })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_existing',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing'
      })
    ).resolves.toBe(false)
  })

  it.each([
    ['writes into an agent a Windows host cannot see in front', 'unknown', true],
    ['still refuses a shell proven in front', 'shell', false]
  ] as const)('under write-unless-shell, %s', async (_label, foreground, expected) => {
    const stub = runtimeStub({ foreground, hostProvesAgent: false })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })
    const deliver = (unprovableHost?: 'write-unless-shell') =>
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_existing',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        ...(unprovableHost ? { unprovableHost } : {})
      })

    await expect(deliver('write-unless-shell')).resolves.toBe(expected)
    await expect(deliver()).resolves.toBe(false)
  })
})

// WSL's wsl.exe and SSH-to-Windows read as unknown even when a shell is alone, so only local Windows may write on unknown.
describe('write-if-shell-provable', () => {
  it.each([
    ['writes on a local Windows pane whose lone shell is provable', 'unknown', true, true],
    ['refuses a shell proven alone', 'shell', true, false],
    ['refuses an unknown WSL or SSH-to-Windows pane', 'unknown', false, false]
  ] as const)('%s', async (_label, foreground, hostProvesShellAlone, expected) => {
    const stub = runtimeStub({
      composerSignal: true,
      foreground,
      hostProvesAgent: false,
      hostProvesShellAlone
    })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'kimi',
        freshLaunch: true,
        text: 'fix the flaky test',
        unprovableHost: 'write-if-shell-provable'
      })
    ).resolves.toBe(expected)
  })
})

describe('cancelling a launch prompt', () => {
  it('pastes nothing when cancelled during the readiness wait, and forwards the signal', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({})
    stub.waitForTerminal.mockImplementation(async () => {
      controller.abort()
      throw new Error('request_aborted')
    })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      signal: controller.signal
    })

    expect(delivered).toBe(false)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true,
      signal: controller.signal
    })
    expect(stub.waitForTerminal).toHaveBeenCalledWith(
      'term_1',
      expect.objectContaining({ signal: controller.signal })
    )
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('stops waiting out a dialog once cancelled', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'agent-approval-prompt' }
    })
    const clock = fakeClock()

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: false,
      text: 'do the thing',
      signal: controller.signal,
      clock: {
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms)
          controller.abort()
        }
      }
    })

    expect(delivered).toBe(false)
    expect(stub.waitForTerminal).toHaveBeenCalledTimes(1)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports text whose Enter was handed over before the cancel as delivered', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      send: async (_handle, _text, options) => {
        const accepted = options.onSubmitWritten
        if (typeof accepted === 'function') {
          accepted()
        }
        controller.abort()
        throw new Error('request_aborted')
      }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        signal: controller.signal
      })
    ).resolves.toBe(true)
  })

  it('reports text cancelled before its Enter as not delivered', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      send: async () => {
        controller.abort()
        throw new Error('request_aborted')
      }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        signal: controller.signal
      })
    ).resolves.toBe(false)
  })

  it('passes no signal or acceptance hook when the caller gave no signal', async () => {
    const stub = runtimeStub({})

    await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: false,
      text: 'do the thing'
    })

    const options = stub.sendTerminalAgentPrompt.mock.calls[0]![2]
    expect(options).not.toHaveProperty('signal')
    expect(options).not.toHaveProperty('onSubmitWritten')
    expect(stub.waitForTerminal.mock.calls[0]![1]).not.toHaveProperty('signal')
  })
})

function fakeClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    }
  }
}

describe('a released message with images, in the terminal that replaced its chat', () => {
  const IMAGE = '/host/uploads/shot.png'
  // The skill keeps its ordinary $name form; the staged file is already its prepared host path.
  const TEXT = 'fix this with $audit, see @/host/uploads/notes.txt'
  const DRAFT = 'original draft A: issue context'
  const PICKED = { model: 'sonnet', effort: 'high' }
  let directory: string

  beforeEach(async () => {
    createStructured.mockClear()
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-rich-terminal-'))
    setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
  })
  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  })

  function base(agent: TuiAgent) {
    return resolveAgentStartupPlanInputs({
      agent,
      settings: {
        agentCmdOverrides: { [agent]: `my-${agent}` },
        agentDefaultArgs: { [agent]: '--verbose --model haiku' },
        agentDefaultEnv: { [agent]: { KEEP: 'unchanged' } }
      },
      platform: 'darwin',
      shell: 'posix',
      isRemote: false
    })
  }

  function body(blocks: unknown[]) {
    return {
      kind: 'message',
      role: 'user',
      blocks,
      skills: [{ name: 'audit', path: '/s/SKILL.md' }]
    }
  }

  /** Prepares and releases a launch whose chat its host can't run, its terminal's prompt reaching
   *  the real per-PTY writer of a live agent. */
  async function launch(args: {
    agent?: TuiAgent
    blocks: unknown[]
    alternative?: unknown
    chatSupported?: boolean
    onWrite?: (
      runtime: Parameters<Parameters<typeof createAgentPromptSubmissionRuntime>[0]>[0],
      data: string
    ) => void
  }) {
    const agent = args.agent ?? 'claude'
    const real = await createAgentPromptSubmissionRuntime(
      (runtime, data) => args.onWrite?.(runtime, data),
      agent
    )
    const ready = {
      handle: real.handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    } as const
    vi.spyOn(real.runtime, 'waitForFreshWorkerComposer').mockResolvedValue(ready)
    vi.spyOn(real.runtime, 'waitForTerminal').mockResolvedValue(ready)
    const host = hostRuntime(
      undefined,
      args.chatSupported ? {} : { createSupport: { supported: false, reason: 'agent' } }
    )
    host.deliverStartupFollowup.mockImplementation((_handle, followup, options) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host fixture types its stub loosely; these are the launch's own follow-up and options.
      real.runtime.deliverStartupFollowup(real.handle, followup as never, options as never)
    )
    const id = operationId()
    await prepare(
      host,
      prepared(id, {
        agent,
        sessionId: `${agent}_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d`,
        terminalAlternative: args.alternative ?? {
          kind: 'planned',
          base: base(agent),
          policy: { kind: 'foreground', promptDelivery: 'auto-submit', isFollowupPath: false }
        }
      })
    )
    await untilAwaitingRelease(host, id)
    await release(host, id, {
      options: PICKED,
      selection: PICKED,
      firstMessage: { clientMessageId: MESSAGE_ID, body: body(args.blocks) }
    })
    return { host, writes: real.writes, settled: await status(host, id, { waitMs: 10_000 }) }
  }

  function command(host: ReturnType<typeof hostRuntime>): string[] {
    const parsed = tokenizeStartupCommand(
      String(host.createTerminal.mock.calls[0]?.[1]?.command),
      'posix'
    )
    return parsed.ok ? parsed.tokens : []
  }

  it('starts clean, then writes its images, its text and one Enter once, under the final choices', async () => {
    const { host, writes, settled } = await launch({
      blocks: [
        { type: 'text', text: TEXT },
        { type: 'image-ref', path: IMAGE }
      ]
    })

    expect(settled).toMatchObject({
      state: 'succeeded',
      result: {
        outcome: { kind: 'terminal' },
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
      }
    })
    expect(writes).toEqual([
      '\x1b[200~/host/uploads/shot.png\x1b[201~ ',
      `\x1b[200~${TEXT}\x1b[201~`,
      '\r'
    ])
    const tokens = command(host)
    expect(tokens[0]).toBe('my-claude')
    expect(tokens).toEqual(expect.arrayContaining(['--verbose', 'sonnet']))
    expect(tokens).not.toContain('haiku')
    // Nothing of the message rides the launch line, and it is delivered by one follow-up.
    expect(JSON.stringify(host.createTerminal.mock.calls)).not.toContain('fix this')
    expect(host.createTerminal.mock.calls[0]?.[1]).toMatchObject({ env: { KEEP: 'unchanged' } })
    expect(host.deliverStartupFollowup).toHaveBeenCalledOnce()
  })

  it('submits a message of images alone', async () => {
    const { writes, settled } = await launch({ blocks: [{ type: 'image-ref', path: IMAGE }] })

    expect(settled).toMatchObject({ result: { prompt: { outcome: 'handed-to-terminal' } } })
    expect(writes).toEqual(['\x1b[200~/host/uploads/shot.png\x1b[201~', '\r'])
  })

  it('leaves input unconfirmed and writes nothing more once its process is replaced mid-message', async () => {
    const { host, writes, settled } = await launch({
      blocks: [
        { type: 'text', text: TEXT },
        { type: 'image-ref', path: IMAGE },
        { type: 'image-ref', path: '/host/uploads/second.png' }
      ],
      onWrite: (runtime, data) => {
        if (data.includes('shot.png')) {
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            0
          )
        }
      }
    })

    // Not a text-only success and not a clean miss: no one sends it again.
    expect(settled).toMatchObject({ result: { prompt: { outcome: 'unconfirmed' } } })
    expect(writes).toEqual(['\x1b[200~/host/uploads/shot.png\x1b[201~'])
    expect(host.deliverStartupFollowup).toHaveBeenCalledOnce()
  })

  it.each([
    { paired: false, pasted: [['term_1', { agent: 'codex', content: DRAFT }]] },
    { paired: true, pasted: [] }
  ])(
    'keeps a held message with images unsent out of view (paired: $paired)',
    async ({ paired, pasted }) => {
      const { host, writes, settled } = await launch({
        agent: 'codex',
        blocks: [
          { type: 'text', text: TEXT },
          { type: 'image-ref', path: IMAGE }
        ],
        alternative: {
          kind: 'planned',
          base: base('codex'),
          policy: {
            kind: 'background',
            prompt: '',
            draftPrompt: DRAFT,
            heldChatMessage: true,
            paired
          }
        }
      })

      expect(settled).toMatchObject({ result: { prompt: { outcome: 'not-delivered' } } })
      // Only the plan's own draft A is pasted; held message B stays with its owner, whole.
      expect(host.pasteStartupDraftWhenReady.mock.calls).toEqual(pasted)
      expect(writes).toEqual([])
      expect(host.deliverStartupFollowup).not.toHaveBeenCalled()
    }
  )

  it('fails a required terminal that cannot attach its image, starting nothing', async () => {
    const { host, settled } = await launch({
      blocks: [{ type: 'image-ref', url: 'https://example.com/shot.png' }],
      alternative: { kind: 'agent', prompt: 'submit' }
    })

    expect(settled).toMatchObject({ state: 'failed', code: 'agent_launch_surface_unavailable' })
    expect(host.createTerminal).not.toHaveBeenCalled()
  })

  it('never lets that unusable terminal veto a chat its host can run', async () => {
    const blocks = [{ type: 'image-ref', url: 'https://example.com/shot.png' }]
    const { host, settled } = await launch({
      blocks,
      alternative: { kind: 'agent', prompt: 'submit' },
      chatSupported: true
    })

    expect(settled).toMatchObject({
      state: 'succeeded',
      result: { prompt: { outcome: 'journaled', messageId: MESSAGE_ID } }
    })
    expect(createStructured.mock.calls[0]?.[0]).toMatchObject({
      firstMessage: { clientMessageId: MESSAGE_ID, body: { blocks } }
    })
    expect(host.createTerminal).not.toHaveBeenCalled()
  })
})
