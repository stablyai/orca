import { expect, it, vi } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { spawnForStablePane } from './stable-owner'

it('prepares only the fresh path and returns a proven raw attach without a second spawn', async () => {
  const provider = new LocalPtyProvider()
  provider.spawn = vi.fn()
  const attached = { id: 'live-session', isReattach: true }
  const prepare = vi.fn().mockResolvedValue(attached)
  const result = await spawnForStablePane({
    runtime: undefined,
    provider,
    spawnOptions: { cols: 80, rows: 24 },
    owner: null,
    beforeFreshSpawn: prepare
  })
  expect(result).toEqual({ result: attached, owner: null })
  expect(prepare).toHaveBeenCalledOnce()
  expect(provider.spawn).not.toHaveBeenCalled()
})

it('prevents fresh dispatch when account preparation fails', async () => {
  const provider = new LocalPtyProvider()
  provider.spawn = vi.fn()
  const prepare = vi.fn().mockRejectedValue(new Error('native account changed'))
  await expect(
    spawnForStablePane({
      runtime: undefined,
      provider,
      spawnOptions: { cols: 80, rows: 24 },
      owner: null,
      beforeFreshSpawn: prepare
    })
  ).rejects.toThrow('native account changed')
  expect(provider.spawn).not.toHaveBeenCalled()
})

it('keeps a stable live owner outside fresh account preparation', async () => {
  const provider = new LocalPtyProvider()
  const attached = { id: 'stable-live', isReattach: true }
  provider.spawn = vi.fn().mockResolvedValue(attached)
  const prepare = vi.fn().mockRejectedValue(new Error('native account changed'))
  const owner = { ptyId: 'stable-live', tabId: 'tab', leafId: 'leaf' }
  const result = await spawnForStablePane({
    runtime: undefined,
    provider,
    spawnOptions: { cols: 80, rows: 24 },
    owner,
    beforeFreshSpawn: prepare
  })
  expect(result).toEqual({ result: attached, owner })
  expect(prepare).not.toHaveBeenCalled()
  expect(provider.spawn).toHaveBeenCalledOnce()
})
