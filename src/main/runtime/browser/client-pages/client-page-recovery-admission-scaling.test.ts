import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([
  [10, false],
  [10, true]
] as const)(
  'expires %i ordinary requests before reservation while exact predecessor cleanup is unknown=%s',
  async (count, unknown) => {
    const h = createRecoveryLoop(['slow'])
    const replaced = vi.spyOn(h.pages, 'replaceClientPagePlacement')
    let release = () => {}
    const calls: Promise<void>[] = []
    try {
      await h.seedNative(['slow'], 'profile-a', unknown)
      const held = h.holdRetirement('slow')
      release = held.release
      if (unknown) {
        h.native.renderer.retirePage.mockRejectedValueOnce(new Error('renderer-retirement-failed'))
      }
      h.attach()
      await held.started
      if (unknown) {
        release()
        await vi.waitFor(() =>
          expect(h.results).toContainEqual({ type: 'closePage', id: 'slow', status: 'failed' })
        )
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const outcomes: string[] = []
      for (let i = 0; i < count; i += 1) {
        calls.push(
          h.authority
            .createClientPage({
              browserPageId: `abandoned-${i}`,
              browserHostClientId: 'client-a',
              pairedDeviceId: 'device-a',
              browserProfileId: 'profile-a',
              executionHostKey: 'waiting-key',
              timeoutMs: 10,
              workspaceId: WORKSPACE
            })
            .then(
              () => {
                outcomes.push('unexpected-success')
              },
              (error) => {
                outcomes.push(error.message)
              }
            )
        )
      }
      const lease = h.authority.select('client-a')
      expect(() => h.authority.requireExecutionHost(lease, 'waiting-key')).toThrow()
      // The predecessor owns one slot; waiting callers must leave all 255 others usable.
      for (let i = 0; i < 254; i += 1) {
        h.authority.placeServerPage(`capacity-${i}`)
      }
      expect(outcomes).toEqual([])
      expect(h.commands.some((c) => c.browserPageId.startsWith('abandoned-'))).toBe(false)
      const independent = await h.authority.createClientPage({
        browserPageId: 'independent',
        browserHostClientId: 'client-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-b',
        executionHostKey: 'execution-host-a',
        workspaceId: WORKSPACE
      })
      expect(independent.pageHostGeneration).toBeGreaterThan(0)
      expect(() => h.authority.placeServerPage('overflow')).toThrow()
      await vi.advanceTimersByTimeAsync(11)
      expect(outcomes).toEqual(Array(count).fill('browser_host_page_creation_timeout'))
      expect(() => h.authority.requireExecutionHost(lease, 'waiting-key')).toThrow()
      vi.useRealTimers()
      release()
      if (unknown) {
        h.attach()
        await vi.waitFor(() => {
          expect(h.errors).toEqual([])
          expect(h.results).toContainEqual({ type: 'closePage', id: 'slow', status: 'completed' })
        })
      }
      await h.published('slow')
      expect(
        h.commands.filter((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
      ).toHaveLength(1)
      expect(replaced.mock.calls.filter(([id]) => id === 'slow')).toHaveLength(1)
      await Promise.all(calls)
      expect(h.commands.some((c) => c.browserPageId.startsWith('abandoned-'))).toBe(false)
      expect(
        h.executor
          .snapshotPageInventory()
          .map((p) => p.browserPageId)
          .sort()
      ).toEqual(['independent', 'slow'])
    } finally {
      release()
      vi.useRealTimers()
      await h.close()
      await Promise.all(calls)
    }
  }
)

it('flushes an earlier valid pending admission when a later page hits real shared capacity', async () => {
  const h = createRecoveryLoop(['first', 'second'])
  const observed: string[] = []
  try {
    for (let i = 0; i < 255; i += 1) {
      h.authority.placeServerPage(`existing-${i}`)
    }
    h.hooks.onNotify = () => {
      const status = h.authority.clientPageInitializations.status(
        'first',
        h.pages.getPage('first')!.placement
      )
      if (status) {
        observed.push(status)
      }
    }
    const connection = h.attach({ inventory: [] })
    await connection.completion
    expect(observed).toContain('pending')
    expect(
      h.profile.session.clientHostedBrowserPagesByWorktree?.[WORKSPACE]?.map((p) => p.browserPageId)
    ).toEqual(['first', 'second'])
  } finally {
    await h.close()
  }
})

it('lets an ordinary page progress beside four genuinely held recovery documents', async () => {
  const ids = ['a', 'b', 'c', 'd']
  const h = createRecoveryLoop(ids)
  try {
    const started = ids.map((id) => h.hold(id))
    h.attach()
    await Promise.all(started)
    const placement = await h.authority.createClientPage({
      browserPageId: 'ordinary',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a'
    })
    expect(placement.pageHostGeneration).toBeGreaterThan(0)
    expect(
      h.executor
        .snapshotPageInventory()
        .map((p) => p.browserPageId)
        .sort()
    ).toEqual(['a', 'b', 'c', 'd', 'ordinary'])
    expect(h.pages.listPages().every((p) => p.placement.pageHostGeneration === 0)).toBe(true)
  } finally {
    await h.close()
  }
})

it('keeps a failed exact retirement charged and parks recovery until another legitimate attach', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'], 'profile-a', true)
    h.native.renderer.retirePage.mockRejectedValue(new Error('renderer-retirement-unavailable'))
    h.attach()
    await vi.waitFor(() =>
      expect(h.results.filter((r) => r.id === 'slow' && r.type === 'closePage')).toEqual([
        { id: 'slow', type: 'closePage', status: 'failed' }
      ])
    )
    expect(h.executor.snapshotPageInventory()).toMatchObject([
      { browserPageId: 'slow', state: 'outcomeUnknown' }
    ])
    for (let i = 0; i < 254; i += 1) {
      h.authority.placeServerPage(`occupied-${i}`)
    }
    const independent = await h.authority.createClientPage({
      browserPageId: 'independent',
      browserHostClientId: 'client-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-b',
      executionHostKey: 'execution-host-a',
      workspaceId: WORKSPACE
    })
    expect(independent.pageHostGeneration).toBeGreaterThan(0)
    expect(() => h.authority.placeServerPage('overflow')).toThrow()
    await expect(
      h.authority.createClientPage({
        browserPageId: 'waiting',
        browserHostClientId: 'client-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'waiting-key',
        workspaceId: WORKSPACE,
        timeoutMs: 10
      })
    ).rejects.toThrow('browser_host_page_creation_timeout')
    expect(h.results.filter((r) => r.id === 'slow' && r.type === 'closePage')).toHaveLength(1)
    const sealed = vi.spyOn(h.authority, 'sealClientPageInitializations')
    h.attach()
    await vi.waitFor(() => {
      expect(sealed).toHaveBeenCalled()
      expect(
        h.results.filter((r) => r.id === 'slow' && r.type === 'closePage' && r.status === 'failed')
      ).toHaveLength(2)
    })
    expect(h.native.renderer.retirePage).toHaveBeenCalledTimes(2)
    expect(
      h.results
        .filter((r) => r.id === 'slow' && r.type === 'closePage')
        .every((r) => r.status === 'failed')
    ).toBe(true)
    expect(
      new Set(
        h.commands
          .filter((c) => c.browserPageId === 'slow' && c.command.type === 'closePage')
          .map((c) => c.commandId)
      ).size
    ).toBe(2)
    expect(
      h.commands.filter((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
    ).toEqual([])
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.executor.snapshotPageInventory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserPageId: 'slow', state: 'outcomeUnknown' }),
        expect.objectContaining({ browserPageId: 'independent', state: 'active' })
      ])
    )
    expect(() => h.authority.placeServerPage('still-overflow')).toThrow()
  } finally {
    h.native.renderer.retirePage.mockResolvedValue(undefined)
    await h.close()
  }
})
