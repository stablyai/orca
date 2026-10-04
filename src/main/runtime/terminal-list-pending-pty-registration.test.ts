import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInventoryRuntime,
  deferred,
  processRow,
  PREDECESSOR,
  PTY,
  WORKTREE
} from './pty-inventory-lifecycle-fixture'

const TAB = '40000000-0000-4000-8000-000000000001'
const LEAF = '40000000-0000-4000-8000-000000000002'

afterEach(() => vi.restoreAllMocks())

describe('terminal listing while a spawn binding is being persisted', () => {
  it.each([
    { host: 'local', ptyId: PTY, connectionId: null, phase: 'binding', incarnationId: PREDECESSOR },
    {
      host: 'SSH',
      ptyId: 'ssh:host-a@@pty2:pending-spawn:1',
      connectionId: 'host-a',
      phase: 'binding'
    },
    { host: 'local', ptyId: PTY, connectionId: null, phase: 'provider' },
    {
      host: 'SSH',
      ptyId: 'ssh:host-a@@pty2:pending-spawn:1',
      connectionId: 'host-a',
      phase: 'provider'
    }
  ])(
    'does not authorize orphan adoption during $host $phase admission',
    async ({ ptyId, connectionId, phase, incarnationId }) => {
      const bindingPersisted = deferred<void>()
      const { runtime } = createInventoryRuntime(async () => [processRow(ptyId)])
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [{ tabId: TAB, worktreeId: WORKTREE, title: '', activeLeafId: LEAF, layout: null }],
        leaves: [
          {
            tabId: TAB,
            worktreeId: WORKTREE,
            leafId: LEAF,
            paneRuntimeId: 1,
            ptyId: null,
            paneTitle: null,
            title: ''
          }
        ]
      })

      const releaseSpawn =
        phase === 'provider' ? await runtime.acquireWorktreeTerminalSpawn(WORKTREE) : undefined
      if (phase === 'binding') {
        runtime.beginPtyRegistration(ptyId, incarnationId)
      }
      // Spawn commit awaits durable binding persistence before publishing the runtime surface.
      const commit = bindingPersisted.promise.then(() => {
        runtime.registerPty(ptyId, WORKTREE, connectionId, {
          tabId: TAB,
          leafId: LEAF,
          incarnationId: PREDECESSOR
        })
      })
      try {
        await expect(
          runtime.listTerminals(`id:${WORKTREE}`, undefined, {
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
          })
        ).rejects.toThrow('terminal_surface_ownership_unavailable')
        expect(runtime.capture(ptyId).verdict).toMatchObject({ status: 'live' })
      } finally {
        bindingPersisted.resolve()
        try {
          await commit
        } finally {
          releaseSpawn?.()
        }
      }

      const committed = await runtime.listTerminals(`id:${WORKTREE}`, undefined, {
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      })
      expect(committed.terminals).toEqual([
        expect.objectContaining({
          ptyId,
          tabId: TAB,
          leafId: LEAF,
          connected: true,
          incarnationId: PREDECESSOR,
          orphaned: false
        })
      ])
    }
  )

  it('continues reporting a committed surface while another spawn is pending', async () => {
    const { runtime } = createInventoryRuntime(async () => [processRow()])
    runtime.register()
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(WORKTREE)
    try {
      const listed = await runtime.listTerminals(`id:${WORKTREE}`)
      expect(listed.terminals).toEqual([
        expect.objectContaining({ ptyId: PTY, connected: true, orphaned: false })
      ])
    } finally {
      releaseSpawn()
    }
  })

  it('does not block orphan recovery in an unrelated workspace', async () => {
    const { runtime } = createInventoryRuntime(async () => [processRow()])
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn('repo::/tmp/another-workspace')
    try {
      const listed = await runtime.listTerminals(`id:${WORKTREE}`)
      expect(listed.terminals).toEqual([
        expect.objectContaining({ ptyId: PTY, connected: true, orphaned: true })
      ])
    } finally {
      releaseSpawn()
    }
  })

  it('permits orphan recovery once the competing spawn admission has ended', async () => {
    const { runtime } = createInventoryRuntime(async () => [processRow()])
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(WORKTREE)
    runtime.beginPtyRegistration(PTY, PREDECESSOR)
    try {
      await expect(runtime.listTerminals(`id:${WORKTREE}`)).rejects.toThrow(
        'terminal_surface_ownership_unavailable'
      )
    } finally {
      runtime.cancelPendingPtyRegistration(PTY, PREDECESSOR)
      releaseSpawn()
    }
    const listed = await runtime.listTerminals(`id:${WORKTREE}`)
    expect(listed.terminals).toEqual([
      expect.objectContaining({ ptyId: PTY, connected: true, orphaned: true })
    ])
  })
})
