import { describe, expect, it, vi } from 'vitest'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import { ownPrRefusal, type OwnPrGuardDeps } from './own-pr-trigger-guard'

const NOW = 1_000_000
const head = { repoId: '777', number: 5, headRef: 'carol/fix-login', headSha: 'a'.repeat(40) }
const ownPr = {
  automationId: 'auto-1',
  event: {
    key: 'pr:1:opened',
    occurredAt: NOW,
    actorId: '100',
    fromOwner: true as const,
    place: 'acme/web',
    pr: head
  }
}
const run: Pick<AutomationRunEvent, 'source' | 'event' | 'fromOwner' | 'place'> = {
  source: 'github',
  event: 'pr_opened',
  fromOwner: true,
  place: 'acme/web'
}

function deps(overrides: Partial<OwnPrGuardDeps> = {}): Pick<OwnPrGuardDeps, 'isBotWork'> {
  return { isBotWork: async () => false, ...overrides }
}

describe('own pull request guard', () => {
  it('lets a pull request the owner opened by hand start a from=me automation', async () => {
    const isBotWork = vi.fn(async () => false)
    expect(await ownPrRefusal(deps({ isBotWork }), run, ownPr)).toBeNull()
    expect(isBotWork).toHaveBeenCalledWith({
      repoId: 777,
      repoFullName: 'acme/web',
      number: 5,
      head: { repoId: 777, repoFullName: 'acme/web' },
      headRef: 'carol/fix-login'
    })
  })

  it("starts nothing for a pull request a bot's own work opened as the owner", async () => {
    expect(await ownPrRefusal(deps({ isBotWork: async () => true }), run, ownPr)).toBe('bot_work')
  })

  it("starts nothing when the cloud didn't say the pull request's head", async () => {
    const { pr: _head, ...withoutHead } = ownPr.event
    expect(await ownPrRefusal(deps(), run, { ...ownPr, event: withoutHead })).toBe('no_head')
  })

  it("matches a fork's head by its own repository id, never by the base's name", async () => {
    const isBotWork = vi.fn(async () => false)
    const fork = { ...ownPr, event: { ...ownPr.event, pr: { ...head, headRepoId: '888' } } }
    await ownPrRefusal(deps({ isBotWork }), run, fork)
    expect(isBotWork).toHaveBeenCalledWith(
      expect.objectContaining({ head: { repoId: 888, repoFullName: '' } })
    )
  })

  it("leaves everyone else's events, and the owner's other events, alone", async () => {
    const isBotWork = vi.fn(async () => true)
    const guard = deps({ isBotWork })
    const { fromOwner: _owner, pr: _pr, ...stranger } = ownPr.event
    expect(
      await ownPrRefusal(guard, { ...run, fromOwner: undefined }, { ...ownPr, event: stranger })
    ).toBeNull()
    // A failing check and a Slack message from the owner pass as they always have.
    expect(await ownPrRefusal(guard, { ...run, event: 'ci_failed' }, ownPr)).toBeNull()
    expect(
      await ownPrRefusal(guard, { ...run, source: 'slack', event: 'message' }, ownPr)
    ).toBeNull()
    expect(isBotWork).not.toHaveBeenCalled()
  })
})
