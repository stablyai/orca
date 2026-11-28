// One teammate act, watched from the owner's side of a shared agent's Home.
import { expect, vi } from 'vitest'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import type { rig } from './teammate-tabs.test-support'

type Rig = Awaited<ReturnType<typeof rig>>

const HOST_WIDE = new Set(['sleepingMailChanged', 'botsChanged'])

/** One teammate act, watched: the owner gets nothing and sees nothing new, and no chat stops. */
export async function ownerUntouchedBy(
  r: Rig,
  act: () => Promise<unknown>,
  /** The act ends a chat by design (a delete, a Home Chat replaced). */
  { ends = false }: { ends?: boolean } = {}
): Promise<void> {
  const view = await r.ownerView()
  const probe = ownerWindowProbe(r.runtime, r.profile, r.workspace)
  const stops = vi.spyOn(r.host, 'close')
  try {
    const owner = await probe.ownerState()
    await act()
    await chatTabCommandsSettled()
    // The held-mail set is host-wide, so a newly attached window (the probe's) is sent it whole,
    // and the agents list is too (a share's Home Chat pointer).
    expect(probe.relays.filter((relay) => !HOST_WIDE.has(relay.name))).toEqual([])
    expect(await probe.ownerState()).toBe(owner)
    if (!ends) {
      expect(stops).not.toHaveBeenCalled()
    }
  } finally {
    probe.close()
    stops.mockRestore()
  }
  expect(await r.ownerView()).toBe(view)
}
