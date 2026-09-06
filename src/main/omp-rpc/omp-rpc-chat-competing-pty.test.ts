import { expect, it } from 'vitest'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

it('refuses acquisition when another ordinary local PTY owns the requested OMP session', async () => {
  let spawned = false
  const registry = new OmpRpcChatSessionRegistry({
    spawnClient: () => {
      spawned = true
      throw new Error('must not spawn')
    }
  })

  await expect(
    registry.acquire({
      paneKey: 'tab:first',
      ptyId: 'pty-first',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false,
      hasOtherPtySessionWriter: async (sessionFilePath, ptyId) =>
        sessionFilePath === '/sessions/a.jsonl' && ptyId === 'pty-first'
    })
  ).resolves.toEqual({ status: 'conflict' })
  expect(spawned).toBe(false)
})

it('retires an RPC child that switches onto a session an ordinary PTY is writing', async () => {
  const registry = new OmpRpcChatSessionRegistry({
    spawnClient: () =>
      spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' },
            sessionState: {
              sessionFile: null,
              sessionId: 'session-a',
              isStreaming: false,
              isCompacting: false,
              queuedMessageCount: 0
            }
          },
          'session-owning'
        ).spawnOptions
      )
  })
  await registry.acquire({
    paneKey: 'tab:rpc',
    ptyId: 'pty-replaced',
    cwd: '/work',
    executablePath: 'omp',
    sessionFile: 'session-a',
    sessionFilePath: '/sessions/a.jsonl',
    isPtyAlive: () => false,
    hasOtherPtySessionWriter: async (sessionFilePath) => sessionFilePath === '/sessions/b.jsonl'
  })

  await expect(registry.get('tab:rpc')?.send({ message: '/branch', behavior: 'command' })).resolves.toEqual({
    ok: false,
    reason: 'agent_session_conflict'
  })
  expect(registry.get('tab:rpc')).toBeNull()
})
