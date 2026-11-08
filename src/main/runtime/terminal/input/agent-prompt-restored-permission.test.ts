import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'

const worktrees = vi.hoisted(() => [
  {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/restored-permission',
    isBare: false,
    isMainWorktree: false
  }
])

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue(worktrees)
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
}))

const PTY_ID = 'pty-prompt'
const IDLE_TITLE = '✳ Claude Code'

// Claude Code's Bash permission dialog, as the daemon's snapshot repaints it on reattach.
const PERMISSION_DIALOG = [
  '\x1b[2J\x1b[H',
  ' Bash command\r\n',
  '   touch /private/tmp/x\r\n',
  ' Do you want to proceed?\r\n',
  ' ❯ 1. Yes\r\n',
  '   2. Yes, and don’t ask again for touch commands in /private/tmp\r\n',
  '   3. No, and tell Claude what to do differently (esc)\r\n',
  '\r\n',
  ' Esc to cancel · Tab to amend\r\n'
].join('')

const COMPOSER = [
  '\x1b[2J\x1b[H',
  '─'.repeat(40),
  '\r\n❯ \r\n',
  '─'.repeat(40),
  '\r\n  ? for shortcuts\r\n'
].join('')

/** A runtime that just reattached a Claude pane whose permission wait it hydrated from disk. */
async function createReattachedClaudePane(
  screen: string,
  controller?: Parameters<typeof createAgentPromptSubmissionRuntime>[4]
): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
}> {
  let handle = ''
  const askedAt = Date.now() - 24 * 60_000
  const pane = await createAgentPromptSubmissionRuntime(
    (runtime, data) => {
      // Echo the paste as Claude does, so the send outlives the frame that let it start.
      runtime.onPtyData(PTY_ID, data === '\r' ? '\x1b]0;\u2810 Claude Code\x07' : data, Date.now())
    },
    'claude',
    () => true,
    {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'restored-pane',
          terminalHandle: handle,
          state: 'waiting',
          prompt: 'clean up scratch audio',
          agentType: 'claude',
          connectionId: null,
          receivedAt: askedAt,
          stateStartedAt: askedAt,
          restoredUnconfirmed: true
        }
      ]
    },
    controller
  )
  handle = pane.handle
  vi.spyOn(pane.runtime, 'getTerminalSize').mockReturnValue({ cols: 80, rows: 24 })
  pane.runtime.seedHeadlessTerminal(PTY_ID, screen, { cols: 80, rows: 24 })
  pane.runtime.seedTerminalRestoreTail(PTY_ID, { text: screen, lastTitle: IDLE_TITLE })
  // Let the seed land in the headless grid before the send judges it.
  await pane.runtime.readTerminal(handle, { screen: true })
  return pane
}

describe('agent prompt into a pane reattached at a permission dialog (#35962)', () => {
  afterEach(() => vi.useRealTimers())

  it('refuses while the reattached screen still shows the dialog', async () => {
    const { runtime, handle, writes } = await createReattachedClaudePane(PERMISSION_DIALOG)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'permission'
    })
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'hello', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('sends once a provider-owned screen shows the dialog dismissed', async () => {
    // Esc posts no hook, so only the provider's current frame can retire the restored wait.
    const { runtime, handle } = await createReattachedClaudePane(PERMISSION_DIALOG, {
      serializeProviderBuffer: async () => ({
        data: COMPOSER,
        cols: 80,
        rows: 24,
        seq: 0,
        source: 'headless' as const
      })
    })
    runtime.seedHeadlessTerminal(PTY_ID, PERMISSION_DIALOG, undefined, {
      preferProviderIfExisting: true
    })
    vi.useFakeTimers()

    const submission = runtime.sendTerminalAgentPrompt(handle, 'hello', { inputKind: 'driving' })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
  })

  it('releases a held prompt once the provider-owned dialog is dismissed', async () => {
    let provider = { screen: PERMISSION_DIALOG, seq: 0 }
    const { runtime, handle, writes } = await createReattachedClaudePane(PERMISSION_DIALOG, {
      serializeProviderBuffer: async () => ({
        data: provider.screen,
        cols: 80,
        rows: 24,
        seq: provider.seq,
        source: 'headless' as const
      })
    })
    runtime.seedHeadlessTerminal(PTY_ID, PERMISSION_DIALOG, undefined, {
      preferProviderIfExisting: true
    })
    vi.useFakeTimers()

    const submission = runtime.sendTerminalAgentPrompt(handle, 'hello', {
      inputKind: 'driving',
      onPermission: 'wait'
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toEqual([])

    // Esc repaints the composer: new output outdates the cached frame, and the provider has caught up.
    runtime.onPtyData(PTY_ID, COMPOSER, Date.now())
    provider = { screen: COMPOSER, seq: 1_000 }
    // Well inside the restored row's window, so only the re-read screen can release the hold.
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(submission).resolves.toMatchObject({ accepted: true })
  })

  it('keeps the wait while only the live grid, not the provider, shows the dialog gone', async () => {
    // A provider-preferred grid may hold only the bytes since reattach, so it cannot rule a dialog out.
    const { runtime, handle, writes } = await createReattachedClaudePane(PERMISSION_DIALOG, {
      serializeProviderBuffer: async () => ({
        data: PERMISSION_DIALOG,
        cols: 80,
        rows: 24,
        seq: 0,
        alternateScreen: false,
        source: 'headless' as const
      })
    })
    runtime.seedHeadlessTerminal(PTY_ID, PERMISSION_DIALOG, undefined, {
      preferProviderIfExisting: true
    })
    await runtime.readTerminal(handle, { screen: true })
    // Live bytes outdate the provider's normal-screen frame, which has not caught up with them.
    runtime.onPtyData(PTY_ID, COMPOSER, Date.now())
    await runtime.readTerminal(handle, { screen: true })
    vi.useFakeTimers()

    const submission = runtime.sendTerminalAgentPrompt(handle, 'hello', { inputKind: 'driving' })
    const outcome = expect(submission).rejects.toThrow('agent_prompt_blocked')
    await vi.runAllTimersAsync()

    await outcome
    expect(writes).toEqual([])
  })

  it('sends once the reattached screen shows the composer instead', async () => {
    const { runtime, handle, writes } = await createReattachedClaudePane(COMPOSER)
    vi.useFakeTimers()

    const submission = runtime.sendTerminalAgentPrompt(handle, 'hello', { inputKind: 'driving' })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })
})
