import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => ({
  session: null as { hostSwitcher: boolean; grants: { native: string[] } } | null,
  pushed: [] as string[],
  holdsLeave: false
}))

vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () => ({ getShellSession: () => doubles.session })
}))
vi.mock('../session/session-leave-guard', () => ({ holdSessionLeave: () => doubles.holdsLeave }))
import type { RouteHandoff } from '../navigation/route-handoff'
import type { HostSwitcher } from './use-host-switcher'
import { useHostSwitcher } from './use-host-switcher.web'

const router: Pick<RouteHandoff, 'push'> = {
  push: (href) => {
    doubles.pushed.push(String(href))
  }
}

async function mount(hostId: string): Promise<HostSwitcher> {
  const latest: { current: HostSwitcher | null } = { current: null }
  function Probe() {
    latest.current = useHostSwitcher(hostId, router)
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  if (latest.current === null) {
    throw new Error('hook did not render')
  }
  return latest.current
}

describe("the page's desktop switcher", () => {
  it('stays hidden unless the shell says another desktop exists', async () => {
    doubles.session = null
    expect((await mount('studio')).canSwitch).toBe(false)
    doubles.session = { hostSwitcher: false, grants: { native: ['navigate'] } }
    expect((await mount('studio')).canSwitch).toBe(false)
  })

  it('stays hidden when the shell would refuse the hop to its switcher', async () => {
    doubles.session = { hostSwitcher: true, grants: { native: [] } }
    expect((await mount('studio')).canSwitch).toBe(false)
  })

  it("opens the shell's switcher screen for this desktop", async () => {
    doubles.session = { hostSwitcher: true, grants: { native: ['navigate'] } }
    doubles.pushed = []
    const switcher = await mount('wt/1')
    expect(switcher.canSwitch).toBe(true)
    switcher.open()
    expect(doubles.pushed).toEqual(['/switch-desktop?from=wt%2F1'])
  })

  it('stays on the page when its open session holds the leave', async () => {
    doubles.session = { hostSwitcher: true, grants: { native: ['navigate'] } }
    doubles.pushed = []
    doubles.holdsLeave = true
    ;(await mount('studio')).open()
    doubles.holdsLeave = false
    expect(doubles.pushed).toEqual([])
  })
})
