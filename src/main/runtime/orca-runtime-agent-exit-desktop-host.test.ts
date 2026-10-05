import { afterEach, describe, expect, it, vi } from 'vitest'
import { A, PTY, flush, makeAgentExitHost } from './agent-exit-host.test-fixture'
import type { BrowserWindow } from 'electron'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { NativeChatTargetRead } from '../../shared/native-chat-target-read'

const CLAUDE = { pid: 4242, platform: 'darwin' as const, startTime: 'utc:claude-start' }

/** The fixture host, with a renderer that owns its tabs (a desktop host) after one publication. */
async function makeDesktopHost(options: {
  retire: RuntimeNotifier['retireAgentExitChatView']
  read: RuntimeNotifier['readNativeChatTarget']
}) {
  const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, tabLaunchAgent: 'claude' })
  // Why publish first: the stored publication indexes the candidates and terminal handles.
  await host.published()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths only test the window for presence.
  const window = {} as BrowserWindow
  host.runtime['getAvailableAuthoritativeWindow'] = () => window
  host.runtime.setNotifier({
    closeTerminal: () => {},
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal: () => {},
    sleepWorktree: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {},
    retireAgentExitChatView: options.retire,
    readNativeChatTarget: options.read
  })
  return host
}

afterEach(() => {
  vi.useRealTimers()
})

describe('F2 on a desktop host: the renderer owns committed state', () => {
  it('retries a failed retirement relay and stops once it lands (R1D-1)', async () => {
    vi.useFakeTimers()
    const retire = vi
      .fn<NonNullable<RuntimeNotifier['retireAgentExitChatView']>>()
      .mockRejectedValueOnce(new Error('renderer_unavailable'))
      .mockResolvedValueOnce('applied')
    const host = await makeDesktopHost({ retire, read: async () => ({ kind: 'not-chat-target' }) })
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(retire.mock.calls[0]![2]).toMatchObject({ leafId: A, ptyId: PTY[A] })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retire).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retire).toHaveBeenCalledTimes(2)
    // The retry never re-probed or re-captured the process.
    expect(host.probe).not.toHaveBeenCalled()
  })

  it('a refusal comes only from committed state, and a later read of chat admits a new action', async () => {
    let target: NativeChatTargetRead = { kind: 'not-chat-target' }
    const host = await makeDesktopHost({ retire: async () => 'applied', read: async () => target })
    host.write.mockClear()
    await expect(host.chatSend(A, 'stale')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
    expect(host.write).not.toHaveBeenCalled()
    target = { kind: 'chat-target', presentationToken: 'r.9' }
    await expect(host.chatSend(A, 'fresh')).resolves.toMatchObject({ accepted: true })
  })

  it('treats an unreadable renderer as unknown (narrow policy), never as an exit latch', async () => {
    const read = vi.fn(async (): Promise<NativeChatTargetRead> => {
      throw new Error('chat_view_relay_timeout')
    })
    const host = await makeDesktopHost({ retire: async () => 'applied', read })
    await expect(host.chatSend(A, 'during-reload')).resolves.toMatchObject({ accepted: true })
  })

  it('stops an admitted action whose presentation moved between body and Enter', async () => {
    const tokens = ['r.1', 'r.3']
    const host = await makeDesktopHost({
      retire: async () => 'applied',
      read: async () => ({ kind: 'chat-target', presentationToken: tokens.shift() ?? 'r.3' })
    })
    host.write.mockClear()
    await expect(host.chatSend(A, 'switched', 'hello')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 5
    })
    expect(host.write.mock.calls.map((call) => call[1])).toEqual(['hello'])
  })

  it('keeps a local body ahead of its Enter while the body waits on its viewport (R1B-2)', async () => {
    const host = await makeDesktopHost({
      retire: async () => 'applied',
      read: async () => ({ kind: 'chat-target', presentationToken: 'r.1' })
    })
    host.write.mockClear()
    let releaseBody: () => void = () => {}
    const body = host.runtime.writeNativeChatInputToPty(
      PTY[A]!,
      'body',
      'driving',
      'act-1',
      () =>
        new Promise<boolean>((resolve) => {
          releaseBody = () => resolve(true)
        })
    )
    const enter = host.runtime.writeNativeChatInputToPty(PTY[A]!, '\r', 'driving', 'act-1')
    await flush()
    expect(host.write).not.toHaveBeenCalled()
    releaseBody()
    await Promise.all([body, enter])
    expect(host.write.mock.calls.map((call) => call[1])).toEqual(['body', '\r'])
  })
})
