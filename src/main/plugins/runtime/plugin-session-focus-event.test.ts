import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginRuntimeDelegate, watchPluginWorkspaceContext } from './plugin-runtime-binding'

function focusSource() {
  let id: string | null | undefined = 'codex_A'
  const context = {
    worktreeId: 'folder:projects',
    path: '/projects',
    branch: '',
    displayName: 'Projects'
  }
  const delegate = pluginRuntimeDelegate(
    {
      resolveActiveWorktreeContext: async () => context,
      readActiveSessionId: () => id,
      listTerminals: async () => ({ terminals: [] }),
      sendTerminal: vi.fn(),
      dispatchPluginNotification: vi.fn(),
      listAgentTasksByPaneKey: () => ({})
    },
    () => []
  )
  return {
    delegate,
    select: (value: typeof id) => {
      id = value
    }
  }
}
afterEach(() => {
  vi.useRealTimers()
})
describe('workspace events include selected native chats', () => {
  it('drops a slow stale focus lookup and a lookup finishing after disposal', async () => {
    vi.useFakeTimers()
    const source = focusSource()
    const slow = Promise.withResolvers<{ terminals: [] }>()
    const list = vi.spyOn(source.delegate, 'listTerminals').mockReturnValueOnce(slow.promise)
    const seen: unknown[] = []
    let changed = () => {}
    const stop = watchPluginWorkspaceContext({
      delegate: source.delegate,
      events: {
        wantsEvent: () => true,
        emitEvent: (_event, payload) => {
          seen.push(payload)
        }
      },
      onSessionWritten: () => () => {},
      onStateWritten: () => () => {},
      onSessionTabsChanged: (listener) => {
        changed = listener
        return () => {}
      }
    })
    changed()
    await vi.advanceTimersByTimeAsync(200)
    source.select('claude_B')
    changed()
    await vi.advanceTimersByTimeAsync(200)
    slow.resolve({ terminals: [] })
    await vi.runAllTimersAsync()
    expect(seen).toEqual([
      {
        context: {
          workspaceId: 'folder:projects',
          branch: '',
          displayName: 'Projects',
          terminals: [],
          activeSessionId: 'claude_B'
        }
      }
    ])
    const closing = Promise.withResolvers<{ terminals: [] }>()
    list.mockReturnValueOnce(closing.promise)
    source.select('codex_C')
    changed()
    await vi.advanceTimersByTimeAsync(200)
    stop()
    closing.resolve({ terminals: [] })
    await vi.runAllTimersAsync()
    expect(seen).toEqual([
      {
        context: {
          workspaceId: 'folder:projects',
          branch: '',
          displayName: 'Projects',
          terminals: [],
          activeSessionId: 'claude_B'
        }
      }
    ])
  })
})
