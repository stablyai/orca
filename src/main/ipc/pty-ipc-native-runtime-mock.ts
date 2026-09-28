import { vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { existsSyncMock, statSyncMock, spawnMock } from './pty-ipc-mock-registry'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: async (...args: unknown[]) => {
    if (!existsSyncMock(args[0])) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return statSyncMock(...args)
  }
}))

vi.mock('../daemon/pty-subprocess/bun-pty-process', () => ({
  canUseBunPty: () => true,
  spawnBunPty: (args: {
    file: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  }) =>
    spawnMock(args.file, args.args, {
      cwd: args.cwd,
      env: args.env,
      cols: args.cols,
      rows: args.rows,
      name: args.env.TERM
    })
}))

export function finishMockNativePtyProcesses(): void {
  for (const result of spawnMock.mock.results) {
    if (result.type !== 'return') {
      continue
    }
    for (const [onExit] of result.value?.onExit?.mock?.calls ?? []) {
      onExit({ exitCode: 0 })
    }
  }
}
