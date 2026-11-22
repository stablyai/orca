import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalHost } from '../terminal-host'
import { createMockSubprocess } from '../../pty-subprocess/testing/fake-restart-subprocess'

const streamClient = () => ({ onData: vi.fn(), onExit: vi.fn() })
const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  agent: 'codex' as const
}
const surface = {
  worktreeId: 'workspace',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: 'term_claimed'
}
let host: TerminalHost
let handles: ReturnType<typeof createMockSubprocess>[]
beforeEach(() => {
  handles = []
  host = new TerminalHost({
    spawnSubprocess: () => {
      const handle = createMockSubprocess()
      handles.push(handle)
      return handle
    }
  })
})
afterEach(async () => {
  for (const handle of handles) {
    handle._simulateExit(0)
  }
  await host.dispose()
})
it('refuses a fresh restart when another request owns its claim without detaching that viewer', async () => {
  const ownerClient = streamClient()
  const owner = await host.createOrAttach({
    sessionId: 'winner',
    cols: 80,
    rows: 24,
    streamClient: ownerClient,
    agentSessionEnsure: { claim, surface }
  })
  const rejectedClient = streamClient()
  await expect(
    host.createOrAttach({
      sessionId: 'losing-restart',
      cols: 80,
      rows: 24,
      streamClient: rejectedClient,
      requireFreshSession: true,
      agentSessionEnsure: { claim, surface }
    })
  ).rejects.toThrow('agent_session_conflict')
  handles[0]!._simulateExit(17)
  expect(ownerClient.onExit.mock.calls[0]?.slice(0, 2)).toEqual([17, owner.incarnationId])
  expect(rejectedClient.onExit).not.toHaveBeenCalled()
  expect(handles).toHaveLength(1)
})

it('leaves the current viewer attached when a fresh start names a live session', async () => {
  const currentViewer = streamClient()
  await host.createOrAttach({
    sessionId: 'live-session',
    cols: 80,
    rows: 24,
    streamClient: currentViewer
  })
  const nextViewer = streamClient()
  await expect(
    host.createOrAttach({
      sessionId: 'live-session',
      cols: 80,
      rows: 24,
      streamClient: nextViewer,
      requireFreshSession: true
    })
  ).rejects.toThrow('terminal_pane_owner_changed')
  handles[0]!._simulateExit(17)
  expect(currentViewer.onExit.mock.calls[0]?.[0]).toBe(17)
  expect(nextViewer.onExit).not.toHaveBeenCalled()
})
