import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCatalogEntry } from '../transport/types'

const doubles = vi.hoisted(() => ({
  catalog: [] as HostCatalogEntry[],
  loads: 0,
  unreadable: false,
  holdsLeave: false,
  pendingLoad: null as Promise<void> | null,
  ctx: {
    primeHosts: () => {},
    getKnownState: () => 'connected' as const,
    subscribeHostState: () => () => {}
  }
}))

vi.mock('../transport/client-context', () => ({ useRpcClientContext: () => doubles.ctx }))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: async () => {
    doubles.loads += 1
    const catalog = doubles.catalog
    if (doubles.pendingLoad !== null) {
      await doubles.pendingLoad
    }
    if (doubles.unreadable) {
      throw new Error('keychain unavailable')
    }
    return catalog
  }
}))
vi.mock('../session/session-leave-guard', () => ({ holdSessionLeave: () => doubles.holdsLeave }))

import { useHostSwitcher, type HostSwitcher } from './use-host-switcher'

function entry(
  id: string,
  lastConnected: number,
  credentialStatus: HostCatalogEntry['credentialStatus'] = 'ready'
): HostCatalogEntry {
  const stored = {
    id,
    name: id,
    endpoint: `ws://10.0.0.1:6768/${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected
  }
  return {
    ...stored,
    credentialStatus,
    profile: credentialStatus === 'ready' ? { ...stored, deviceToken: 'token' } : null
  }
}

async function mount(currentHostId: string) {
  const router = { calls: [] as string[] }
  const routerApi = {
    dismissTo: (href: '/') => router.calls.push(`dismissTo ${href}`),
    push: (href: `/h/${string}`) => router.calls.push(`push ${href}`)
  }
  const latest: { current: HostSwitcher | null } = { current: null }
  function Probe() {
    latest.current = useHostSwitcher(currentHostId, routerApi)
    return null
  }
  let renderer: ReturnType<typeof create> | null = null
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  const unmount = async () => {
    await act(async () => renderer?.unmount())
  }
  const switcher = () => {
    if (latest.current === null) {
      throw new Error('hook did not render')
    }
    return latest.current
  }
  return { router, switcher, unmount }
}

async function pickThenClose(
  { switcher }: Awaited<ReturnType<typeof mount>>,
  hostId: string | null
) {
  await act(async () => switcher().open())
  await act(async () => {
    if (hostId !== null) {
      switcher().pickerProps.onSelect(hostId)
    }
    switcher().pickerProps.onClose()
  })
  await act(async () => {
    switcher().pickerProps.onAfterClose()
  })
}

function holdNextLoad(): () => void {
  let finish = () => {}
  doubles.pendingLoad = new Promise((resolve) => {
    finish = resolve
  })
  return finish
}

async function pickAndCloseWithoutWaiting(
  { switcher }: Awaited<ReturnType<typeof mount>>,
  hostId: string
): Promise<{ result: Promise<boolean> }> {
  await act(async () => switcher().open())
  let result: Promise<boolean> = Promise.resolve(false)
  await act(async () => {
    switcher().pickerProps.onSelect(hostId)
    switcher().pickerProps.onClose()
    result = switcher().pickerProps.onAfterClose()
  })
  return { result }
}

beforeEach(() => {
  doubles.loads = 0
  doubles.unreadable = false
  doubles.holdsLeave = false
  doubles.pendingLoad = null
  doubles.catalog = [
    entry('studio', 10),
    entry('locked', 99, 'temporarily-unavailable'),
    entry('laptop', 50)
  ]
})

describe('useHostSwitcher', () => {
  it('lists connectable desktops newest first and leaves out ones whose login is unavailable', async () => {
    const { switcher } = await mount('studio')
    expect(switcher().canSwitch).toBe(true)
    expect(switcher().pickerProps.options.map((option) => option.value)).toEqual([
      'laptop',
      'studio'
    ])
  })

  it('is not offered when no other connectable desktop exists', async () => {
    doubles.catalog = [entry('studio', 10), entry('locked', 99, 'temporarily-unavailable')]
    expect((await mount('studio')).switcher().canSwitch).toBe(false)
  })

  it('is still offered when the current desktop itself dropped out of the list', async () => {
    doubles.catalog = [entry('studio', 10, 'temporarily-unavailable'), entry('laptop', 50)]
    expect((await mount('studio')).switcher().canSwitch).toBe(true)
  })

  it('goes home and then opens the picked desktop, only after the sheet closes', async () => {
    const mounted = await mount('studio')
    await pickThenClose(mounted, 'laptop')
    expect(mounted.router.calls).toEqual(['dismissTo /', 'push /h/laptop'])
  })

  it('stays put when the current desktop is picked or nothing is picked', async () => {
    const mounted = await mount('studio')
    await pickThenClose(mounted, 'studio')
    await pickThenClose(mounted, null)
    expect(mounted.router.calls).toEqual([])
  })

  it('drops a pick that was unpaired while the sheet was open', async () => {
    const mounted = await mount('studio')
    await act(async () => mounted.switcher().open())
    doubles.catalog = [entry('studio', 10), entry('desk', 20)]
    await act(async () => mounted.switcher().open())
    await act(async () => {
      mounted.switcher().pickerProps.onSelect('laptop')
      mounted.switcher().pickerProps.onClose()
    })
    await act(async () => {
      mounted.switcher().pickerProps.onAfterClose()
    })
    expect(mounted.router.calls).toEqual([])
  })

  it('waits for a slow reload on open, then opens a pick it still lists', async () => {
    const mounted = await mount('studio')
    const finishLoad = holdNextLoad()
    const { result } = await pickAndCloseWithoutWaiting(mounted, 'laptop')
    expect(mounted.router.calls).toEqual([])
    await act(async () => finishLoad())
    expect(await result).toBe(true)
    expect(mounted.router.calls).toEqual(['dismissTo /', 'push /h/laptop'])
  })

  it('drops a pick the slow reload on open removes', async () => {
    const mounted = await mount('studio')
    const finishLoad = holdNextLoad()
    doubles.catalog = [entry('studio', 10), entry('desk', 20)]
    const { result } = await pickAndCloseWithoutWaiting(mounted, 'laptop')
    await act(async () => finishLoad())
    expect(await result).toBe(false)
    expect(mounted.router.calls).toEqual([])
  })

  it('drops a waiting pick once the sheet is opened again', async () => {
    const mounted = await mount('studio')
    const finishLoad = holdNextLoad()
    const { result } = await pickAndCloseWithoutWaiting(mounted, 'laptop')
    await act(async () => mounted.switcher().open())
    await act(async () => finishLoad())
    expect(await result).toBe(false)
    expect(mounted.router.calls).toEqual([])
  })

  it('drops a waiting pick once the switcher is gone', async () => {
    const mounted = await mount('studio')
    const finishLoad = holdNextLoad()
    const { result } = await pickAndCloseWithoutWaiting(mounted, 'laptop')
    await mounted.unmount()
    await act(async () => finishLoad())
    expect(await result).toBe(false)
    expect(mounted.router.calls).toEqual([])
  })

  it('keeps the last list when the reload on open fails', async () => {
    const mounted = await mount('studio')
    doubles.unreadable = true
    await pickThenClose(mounted, 'laptop')
    expect(mounted.router.calls).toEqual(['dismissTo /', 'push /h/laptop'])
  })

  it('stays when the open session holds the leave, like the Back button', async () => {
    const mounted = await mount('studio')
    doubles.holdsLeave = true
    await pickThenClose(mounted, 'laptop')
    expect(mounted.router.calls).toEqual([])
  })

  it('reloads the desktop list on mount and on open, not on close', async () => {
    const mounted = await mount('studio')
    await pickThenClose(mounted, null)
    expect(doubles.loads).toBe(2)
  })

  it('reports the list as loaded even when it cannot be read, so its screen still opens', async () => {
    doubles.unreadable = true
    const { switcher } = await mount('studio')
    expect(switcher().loaded).toBe(true)
    expect(switcher().canSwitch).toBe(false)
  })
})
