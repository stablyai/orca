import {
  classifyTerminalCreationFailure,
  readTerminalStartFailure
} from '../../shared/terminal-start-failure'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  createInventoryRuntime,
  deferred,
  processRow,
  PREDECESSOR,
  PTY,
  WORKTREE
} from './pty-inventory-lifecycle-fixture'
import { registerBoundPty } from './bind-first-pane.test-fixture'

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
        phase === 'provider'
          ? await runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(WORKTREE, null))
          : undefined
      if (phase === 'binding') {
        runtime.beginPtyRegistration(ptyId, incarnationId)
      }
      // Spawn commit awaits durable binding persistence before publishing the runtime surface.
      const commit = bindingPersisted.promise.then(() => {
        registerBoundPty(runtime, ptyId, WORKTREE, connectionId, {
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
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKTREE, null)
    )
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
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget('repo::/tmp/another-workspace', null)
    )
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
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKTREE, null)
    )
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

describe('startup exit evidence incarnation', () => {
  it('uses only the rejected incarnation, even when another exit overwrote the bounded verdict', () => {
    const { runtime } = createInventoryRuntime(async () => [])
    const claim = runtime.beginPtyRegistration(PTY)
    runtime.onPtyExit(PTY, 256, PREDECESSOR, {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 256, initialOutputDiagnostic: 'git-bash-console-capacity' }
    })
    expect(() => runtime.assertPtyRegistrationAllowed(PTY, PREDECESSOR)).toThrow(
      'agent_session_exited_during_start'
    )
    try {
      runtime.assertPtyRegistrationAllowed(PTY, PREDECESSOR)
    } catch (error) {
      expect(readTerminalStartFailure(error)).toBeUndefined()
      expect(
        readTerminalStartFailure(
          classifyTerminalCreationFailure(error, { id: PTY, incarnationId: PREDECESSOR })
        )
      ).toMatchObject({
        incarnationId: PREDECESSOR
      })
    }
    runtime.onPtyExit(PTY, 1, 'other-incarnation', {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 1 }
    })
    for (const incarnation of [PREDECESSOR, undefined]) {
      expect(() => runtime.assertPtyRegistrationAllowed(PTY, incarnation)).toThrow(
        'agent_session_exited_during_start'
      )
      try {
        runtime.assertPtyRegistrationAllowed(PTY, incarnation)
      } catch (error) {
        expect(readTerminalStartFailure(error)).toBeUndefined()
      }
    }
    runtime.cancelPendingPtyRegistration(PTY, undefined, claim)
  })
})
