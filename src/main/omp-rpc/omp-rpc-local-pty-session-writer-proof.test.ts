import { expect, it } from 'vitest'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { hasOtherOmpLocalPtySessionWriter } from './omp-rpc-local-pty-session-writer-proof'

it('ignores an ordinary PTY that has no OMP session identity', async () => {
  const hasWriter = await hasOtherOmpLocalPtySessionWriter({
    sessionFilePath: '/sessions/session-a.jsonl',
    excludedPtyId: 'pty-rpc',
    provider: {
      listProcesses: async () => [{ id: 'pty-daemon', cwd: '/work' }]
    } as Pick<IPtyProvider, 'listProcesses'>,
    resolveSessionIdentity: async () => null
  })

  expect(hasWriter).toBe(false)
})

it('treats an unreadable competing PTY identity as a conflicting writer', async () => {
  const hasWriter = await hasOtherOmpLocalPtySessionWriter({
    sessionFilePath: '/sessions/session-a.jsonl',
    excludedPtyId: 'pty-rpc',
    provider: {
      listProcesses: async () => [{ id: 'pty-daemon', cwd: '/work' }]
    } as Pick<IPtyProvider, 'listProcesses'>,
    resolveSessionIdentity: async () => {
      throw new Error('identity unavailable')
    }
  })

  expect(hasWriter).toBe(true)
})
