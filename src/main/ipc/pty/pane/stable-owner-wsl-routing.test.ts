import { afterEach, expect, it, vi } from 'vitest'
import { spawnForStablePane } from './stable-owner'
import { registerWslPtyProvider } from '../provider/registry'
import { createUnavailablePtyProvider } from '../../../providers/unavailable-pty-provider'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import type { PtySpawnResult } from '../../../providers/types'

const guestOwner = { distro: 'Ubuntu', relayBuildId: 'build+user' }
const id = toAppWslPtyId(guestOwner, 'pty2:guest:1')
const owner = { tabId: 'tab', leafId: 'leaf', ptyId: id }
const releases: (() => void)[] = []
afterEach(() => releases.splice(0).forEach((release) => release()))
const native = () => ({ ...createUnavailablePtyProvider(), spawn: vi.fn() })

it('uses the late guest owner instead of the provider selected for a fresh native spawn', async () => {
  const host = native()
  const spawn = vi.fn(async () => ({ id, isReattach: true }))
  releases.push(registerWslPtyProvider(guestOwner, { ...native(), spawn }))
  const result = await spawnForStablePane({
    runtime: undefined,
    provider: host,
    owner,
    spawnOptions: { cols: 80, rows: 24 }
  })
  expect(result.result.id).toBe(id)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, attachOnly: true }))
  expect(host.spawn).not.toHaveBeenCalled()
})

it('does not replace a disconnected guest with a fresh host terminal', async () => {
  const host = native()
  await expect(
    spawnForStablePane({
      runtime: undefined,
      provider: host,
      owner,
      spawnOptions: { cols: 80, rows: 24 }
    })
  ).rejects.toThrow('not connected')
  expect(host.spawn).not.toHaveBeenCalled()
})

it.each(['reply', 'failure'] as const)(
  'refuses a retired provider whose pending attach returns %s',
  async (outcome) => {
    const host = native()
    let finish = () => {}
    const spawn = vi.fn(
      () =>
        new Promise<PtySpawnResult>((resolve, reject) => {
          finish = () =>
            outcome === 'reply'
              ? resolve({ id, isReattach: true })
              : reject(new Error('retired connection failure'))
        })
    )
    const release = registerWslPtyProvider(guestOwner, { ...native(), spawn })
    releases.push(release)
    const pending = spawnForStablePane({
      runtime: undefined,
      provider: host,
      owner,
      spawnOptions: { cols: 80, rows: 24 }
    })
    release()
    finish()
    await expect(pending).rejects.toThrow('owner changed during attach')
    expect(host.spawn).not.toHaveBeenCalled()
  }
)
