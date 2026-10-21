import { describe, expect, it, vi } from 'vitest'
import {
  RestoredPaneStarter,
  restoredPaneStartPlan,
  type RestoredPane,
  type RestoredPaneStartPorts
} from './restored-pane-start'

const PANE: RestoredPane = {
  worktreeId: 'repo-1::/repo',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}
const OWN = 'repo-1::/repo@@abc'

function ports(over: Partial<RestoredPaneStartPorts> = {}) {
  let bound: string | null | undefined = OWN
  const live = new Set<string>()
  const start = vi.fn(async () => {
    bound = 'pty-new'
    live.add('pty-new')
    return 'pty-new'
  })
  return {
    live,
    setBound: (id: string | null | undefined) => {
      bound = id
    },
    ports: {
      boundPtyId: () => bound,
      isLive: (ptyId: string) => live.has(ptyId),
      start,
      ...over
    } satisfies RestoredPaneStartPorts,
    start
  }
}

describe('restoredPaneStartPlan', () => {
  it("restores from its own stored terminal, never another workspace's", () => {
    expect(restoredPaneStartPlan(PANE, OWN)).toEqual({ sessionId: OWN })
    expect(restoredPaneStartPlan(PANE, 'repo-2::/other@@x')).toEqual({})
    expect(restoredPaneStartPlan(PANE, undefined)).toEqual({})
    // An SSH id names its connection, not a workspace, so the pane reattaches over the relay.
    expect(restoredPaneStartPlan(PANE, 'ssh:ssh-1@@relay-pty')).toEqual({
      sessionId: 'ssh:ssh-1@@relay-pty'
    })
  })
})

describe('RestoredPaneStarter', () => {
  it('starts a pane with no live terminal once for concurrent triggers, all bound to it', async () => {
    const { ports: p, start } = ports()
    const starter = new RestoredPaneStarter(p)

    const results = await Promise.all([
      starter.ensureStarted(PANE),
      starter.ensureStarted(PANE),
      starter.ensureStarted(PANE)
    ])

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(PANE, { sessionId: OWN }, {})
    expect(results).toEqual(['pty-new', 'pty-new', 'pty-new'])
  })

  it('starts nothing for a pane already live, or one main no longer holds', async () => {
    const live = ports()
    live.live.add(OWN)
    expect(await new RestoredPaneStarter(live.ports).ensureStarted(PANE)).toBe(OWN)
    expect(live.start).not.toHaveBeenCalled()

    const gone = ports()
    gone.setBound(null)
    expect(await new RestoredPaneStarter(gone.ports).ensureStarted(PANE)).toBeNull()
    expect(gone.start).not.toHaveBeenCalled()
  })

  it("starts fresh a pane still bound to another workspace's live terminal, never resolving to it", async () => {
    const foreign = 'repo-2::/other@@x'
    const harness = ports()
    harness.setBound(foreign)
    harness.live.add(foreign)
    harness.start.mockImplementationOnce(async () => {
      throw new Error('shell not found')
    })

    await expect(new RestoredPaneStarter(harness.ports).ensureStarted(PANE)).rejects.toThrow(
      'shell not found'
    )
    expect(harness.start).toHaveBeenCalledWith(PANE, {}, {})
  })

  it('resolves to the terminal another starter bound when its own start lost the race', async () => {
    const harness = ports()
    harness.start.mockImplementationOnce(async () => {
      harness.setBound('pty-window')
      harness.live.add('pty-window')
      throw new Error('terminal_pane_owner_unknown')
    })

    expect(await new RestoredPaneStarter(harness.ports).ensureStarted(PANE)).toBe('pty-window')
  })

  it('reports a failed start that left the pane without a live terminal', async () => {
    const harness = ports()
    harness.start.mockRejectedValueOnce(new Error('shell not found'))

    await expect(new RestoredPaneStarter(harness.ports).ensureStarted(PANE)).rejects.toThrow(
      'shell not found'
    )
  })
})
