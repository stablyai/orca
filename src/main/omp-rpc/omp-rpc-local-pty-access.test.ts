import { expect, it, vi } from 'vitest'

const listProcesses = vi.hoisted(() => vi.fn())
const getSlavePath = vi.hoisted(() => vi.fn())
const resolveOmpPaneSessionIdentity = vi.hoisted(() => vi.fn())

vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses }),
  tryGetProviderForPty: () => ({ getSlavePath })
}))
vi.mock('../native-chat/omp-terminal-session-identity', () => ({
  resolveOmpPaneSessionIdentity
}))

import { hasOtherLocalOmpRpcPtySessionWriter } from './omp-rpc-local-pty-access'

it('does not let an ordinary POSIX pane without a slave path block an OMP RPC takeover', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    listProcesses.mockResolvedValue([{ id: 'ordinary-shell', cwd: '/work' }])
    getSlavePath.mockReturnValue(undefined)
    resolveOmpPaneSessionIdentity.mockResolvedValue({
      sessionFilePath: '/sessions/target.jsonl',
      sessionId: 'target',
      source: 'mtime-fallback'
    })

    await expect(
      hasOtherLocalOmpRpcPtySessionWriter('/sessions/target.jsonl', 'omp-pane')
    ).resolves.toBe(false)
  } finally {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  }
})

it('treats a Windows ConPTY mtime match as a competing OMP writer', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    listProcesses.mockResolvedValue([{ id: 'omp-pane-b', cwd: 'C:\\work' }])
    getSlavePath.mockReturnValue(undefined)
    resolveOmpPaneSessionIdentity.mockResolvedValue({
      sessionFilePath: 'C:\\sessions\\target.jsonl',
      sessionId: 'target',
      source: 'mtime-fallback'
    })

    await expect(
      hasOtherLocalOmpRpcPtySessionWriter('C:\\sessions\\target.jsonl', 'omp-pane-a')
    ).resolves.toBe(true)
  } finally {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  }
})
