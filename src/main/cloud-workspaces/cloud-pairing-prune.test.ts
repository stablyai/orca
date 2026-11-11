import { describe, expect, it, vi } from 'vitest'
import {
  createCloudPairingPrune,
  type CloudPairingBindings,
  type CloudSandboxPresence
} from './cloud-pairing-prune'

const A = 'sbx_aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'sbx_bbbbbbbbbbbbbbbbbbbbbbbb'

function setup(options: {
  bindings: CloudPairingBindings
  listed?: string[] | null
  presence?: Record<string, CloudSandboxPresence>
  account?: () => string | null
}) {
  let bindings = structuredClone(options.bindings)
  const removed: string[] = []
  const presence = vi.fn(async (id: string) => options.presence?.[id] ?? 'unknown')
  const listVisible = vi.fn(async () =>
    options.listed === null ? null : new Set(options.listed ?? [])
  )
  let clock = 0
  const prune = createCloudPairingPrune({
    activeAccountId: options.account ?? (() => 'team-1'),
    readBindings: async () => structuredClone(bindings),
    updateBindings: async (change) => {
      bindings = change(structuredClone(bindings))
    },
    listVisible,
    presence,
    removeEnvironment: async (id) => {
      removed.push(id)
    },
    now: () => clock
  })
  return {
    prune,
    removed,
    presence,
    listVisible,
    bindings: () => bindings,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('cloud pairing prune (LC-1)', () => {
  it('drops a pairing missing from the list once one more fetch confirms the sandbox is gone', async () => {
    const t = setup({
      bindings: {
        [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-1' },
        [B]: { environmentId: 'env-b', grantId: null, accountId: 'team-1' }
      },
      listed: [B],
      presence: { [A]: 'gone' }
    })
    await t.prune.run({ force: true })
    expect(t.presence).toHaveBeenCalledWith(A)
    expect(t.presence).not.toHaveBeenCalledWith(B)
    expect(t.removed).toEqual(['env-a'])
    expect(Object.keys(t.bindings())).toEqual([B])
  })

  it('a failed list never drops anything (network blip)', async () => {
    const t = setup({
      bindings: { [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-1' } },
      listed: null,
      presence: { [A]: 'gone' }
    })
    await t.prune.run({ force: true })
    expect(t.presence).not.toHaveBeenCalled()
    expect(t.removed).toEqual([])
  })

  it('keeps a pairing when the confirming fetch fails or finds the sandbox', async () => {
    for (const answer of ['unknown', 'present'] as const) {
      const t = setup({
        bindings: { [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-1' } },
        listed: [],
        presence: { [A]: answer }
      })
      await t.prune.run({ force: true })
      expect(t.removed).toEqual([])
      expect(Object.keys(t.bindings())).toEqual([A])
    }
  })

  it("leaves another team's pairings alone", async () => {
    const t = setup({
      bindings: { [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-2' } },
      listed: [],
      presence: { [A]: 'gone' }
    })
    await t.prune.run({ force: true })
    expect(t.listVisible).not.toHaveBeenCalled()
    expect(t.removed).toEqual([])
  })

  it('keeps everything when the team switches mid-check', async () => {
    let account = 'team-1'
    const t = setup({
      bindings: { [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-1' } },
      listed: [],
      presence: { [A]: 'gone' },
      account: () => account
    })
    t.presence.mockImplementation(async () => {
      account = 'team-2'
      return 'gone'
    })
    await t.prune.run({ force: true })
    expect(t.removed).toEqual([])
  })

  it('stamps older bindings with the team that lists them', async () => {
    const t = setup({
      bindings: { [A]: { environmentId: 'env-a', grantId: null } },
      listed: [A]
    })
    await t.prune.run({ force: true })
    expect(t.bindings()[A]?.accountId).toBe('team-1')
    expect(t.removed).toEqual([])
  })

  it('forget drops the pairing now, keeping a server another binding still uses', async () => {
    const t = setup({
      bindings: {
        [A]: { environmentId: 'env-shared', grantId: null, accountId: 'team-1' },
        [B]: { environmentId: 'env-shared', grantId: null, accountId: 'team-1' }
      }
    })
    await t.prune.forget(A)
    expect(t.removed).toEqual([])
    await t.prune.forget(B)
    expect(t.removed).toEqual(['env-shared'])
    expect(t.bindings()).toEqual({})
  })

  it('throttles list-triggered runs; a forced run always goes', async () => {
    const t = setup({
      bindings: { [A]: { environmentId: 'env-a', grantId: null, accountId: 'team-1' } },
      listed: [A]
    })
    await t.prune.run()
    await t.prune.run()
    expect(t.listVisible).toHaveBeenCalledTimes(1)
    await t.prune.run({ force: true })
    expect(t.listVisible).toHaveBeenCalledTimes(2)
    t.advance(60_000)
    await t.prune.run()
    expect(t.listVisible).toHaveBeenCalledTimes(3)
  })
})
