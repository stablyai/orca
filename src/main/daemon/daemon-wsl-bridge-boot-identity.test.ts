import { describe, expect, it, vi } from 'vitest'
import { WslBridgeBootIdentity } from './daemon-wsl-bridge-boot-identity'

function identity(options: { running?: boolean; ids?: (string | null)[] } = {}) {
  const ids = [...(options.ids ?? ['boot-1'])]
  const isRunning = vi.fn(async () => options.running ?? true)
  const readBootId = vi.fn(async () => (ids.length > 1 ? ids.shift()! : (ids[0] ?? null)))
  return { boot: new WslBridgeBootIdentity({ isRunning, readBootId }), isRunning, readBootId }
}

describe('WslBridgeBootIdentity', () => {
  it('falls back to an exit when either id is unreadable, or the pane was never noted', async () => {
    for (const ids of [
      [null, 'boot-2'],
      ['boot-1', null]
    ]) {
      const { boot } = identity({ ids })
      boot.noteSpawn('a', 'Ubuntu')
      await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
    }
    await expect(identity().boot.rebootedSinceSpawn('unknown', 'Ubuntu')).resolves.toBe(false)
  })

  it('never reads a distro the background-work gate does not confirm running (E9)', async () => {
    const { boot, readBootId } = identity({ running: false })
    boot.noteSpawn('a', 'Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
    expect(readBootId).not.toHaveBeenCalled()
  })

  // Reviewers of #35050: a spawn during an earlier exit's verdict took the old boot's id.
  it("gives a pane spawned during another's exit verdict the new boot, so its own exit is an exit", async () => {
    const world = { boot: 'boot-1' }
    const readBootId = vi.fn(async () => world.boot)
    const boot = new WslBridgeBootIdentity({ isRunning: async () => true, readBootId })
    boot.noteSpawn('a', 'Ubuntu', 'inc-a')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
    // The distro is terminated and booted again; A's exit arrives, and C opens before A's verdict.
    world.boot = 'boot-2'
    boot.noteExit('Ubuntu')
    boot.noteSpawn('c', 'Ubuntu', 'inc-c')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(true)
    boot.forget('a')

    boot.noteExit('Ubuntu')
    await expect(boot.rebootedSinceSpawn('c', 'Ubuntu')).resolves.toBe(false)
  })

  it('gives a respawn of the same session into a rebooted distro the new boot id', async () => {
    const world = { boot: 'boot-1' }
    const readBootId = vi.fn(async () => world.boot)
    const boot = new WslBridgeBootIdentity({ isRunning: async () => true, readBootId })
    boot.noteSpawn('a', 'Ubuntu', 'inc-1')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
    world.boot = 'boot-2'
    boot.noteExit('Ubuntu')
    boot.noteSpawn('a', 'Ubuntu', 'inc-2')

    boot.noteExit('Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
  })

  // #35050 review, case 1b: a respawn into a rebooted distro beat the dead process's exit event.
  it('re-reads the boot id of a respawn that beat its old incarnation’s exit', async () => {
    const world = { boot: 'boot-1' }
    const readBootId = vi.fn(async () => world.boot)
    const boot = new WslBridgeBootIdentity({ isRunning: async () => true, readBootId })
    boot.noteSpawn('a', 'Ubuntu', 'inc-1')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
    world.boot = 'boot-2'
    // The respawn lands first and takes the cached (old) id; then the stale exit arrives.
    boot.noteSpawn('a', 'Ubuntu', 'inc-2')
    boot.noteStaleExit('a', 'Ubuntu')
    boot.noteSpawn('b', 'Ubuntu', 'inc-b')

    boot.noteExit('Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
    await expect(boot.rebootedSinceSpawn('b', 'Ubuntu')).resolves.toBe(false)
  })

  // #35050 review (b): a pane spawned after the stop was seen, before any exit reached the adapter.
  it('drops the cached id when a running list sees the distro stop, and listens only while panes live', async () => {
    const world = { boot: 'boot-1' }
    const readBootId = vi.fn(async () => world.boot)
    let stopped: ((distros: string[]) => void) | null = null
    const unsubscribe = vi.fn(() => {
      stopped = null
    })
    const boot = new WslBridgeBootIdentity({
      isRunning: async () => true,
      readBootId,
      onDistrosStopped: (listener) => {
        stopped = listener
        return unsubscribe
      }
    })
    expect(stopped).toBeNull()
    boot.noteSpawn('a', 'Ubuntu', 'inc-a')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())

    world.boot = 'boot-2'
    stopped!(['ubuntu'])
    boot.noteSpawn('b', 'Ubuntu', 'inc-b')
    boot.noteExit('Ubuntu')
    await expect(boot.rebootedSinceSpawn('b', 'Ubuntu')).resolves.toBe(false)
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(true)

    boot.forget('a')
    expect(unsubscribe).not.toHaveBeenCalled()
    boot.forget('b')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps the id across a reattach of the same incarnation', async () => {
    const { boot, readBootId } = identity({ ids: ['boot-1', 'boot-2'] })
    boot.noteSpawn('a', 'Ubuntu', 'inc-1')
    boot.noteExit('Ubuntu')
    boot.noteSpawn('a', 'Ubuntu', 'inc-1')
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
  })

  it('shares one read of the current id across a burst of exits', async () => {
    const { boot, readBootId } = identity({ ids: ['boot-1', 'boot-2'] })
    for (const id of ['a', 'b', 'c']) {
      boot.noteSpawn(id, 'Ubuntu')
    }
    await vi.waitFor(() => expect(readBootId).toHaveBeenCalledOnce())
    boot.noteExit('Ubuntu')
    await expect(
      Promise.all(['a', 'b', 'c'].map((id) => boot.rebootedSinceSpawn(id, 'Ubuntu')))
    ).resolves.toEqual([true, true, true])
    expect(readBootId).toHaveBeenCalledTimes(2)
  })

  it('treats a failing read as unreadable', async () => {
    const boot = new WslBridgeBootIdentity({
      isRunning: async () => true,
      readBootId: async () => {
        throw new Error('wsl.exe failed')
      }
    })
    boot.noteSpawn('a', 'Ubuntu')
    await expect(boot.rebootedSinceSpawn('a', 'Ubuntu')).resolves.toBe(false)
  })
})
