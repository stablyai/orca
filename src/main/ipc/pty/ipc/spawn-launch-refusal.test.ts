import { describe, expect, it, vi } from 'vitest'
import { describeLaunchFileUnavailable } from '../../../../shared/launch-prompt-file'
import { takeTerminalLaunchRefusal } from '../../../runtime/terminal-launch-refusals'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  runSpawn: vi.fn()
}))

vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  })
}))
vi.mock('./spawn-run', () => ({ runPtyIpcSpawn: mocks.runSpawn }))

import { installPtySpawnIpcHandler } from './spawn'

describe('a pane spawn refused for what carries its prompt', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only getLocalPtyStartupPromise before delegating to the mocked runner.
  installPtySpawnIpcHandler({ getLocalPtyStartupPromise: () => null } as unknown as PtySpawnIpcDeps)
  const spawn = (args: Partial<PtySpawnIpcArgs>): Promise<unknown> =>
    mocks.handlers.get('pty:spawn')!({}, { cols: 80, rows: 24, ...args })

  it('records the refusal for its tab, for a create waiting on that tab’s handle', async () => {
    const refusal = describeLaunchFileUnavailable('disk full')
    mocks.runSpawn.mockRejectedValueOnce(new Error(refusal))
    await expect(spawn({ tabId: 'tab-refused' })).rejects.toThrow(refusal)
    expect(takeTerminalLaunchRefusal('tab-refused')).toBe(refusal)
  })

  it('records nothing for any other spawn failure', async () => {
    mocks.runSpawn.mockRejectedValueOnce(new Error('spawn ENOENT'))
    await expect(spawn({ tabId: 'tab-other' })).rejects.toThrow('spawn ENOENT')
    expect(takeTerminalLaunchRefusal('tab-other')).toBeUndefined()
  })
})
