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

it('publishes an early native receipt only for its admitted incarnation and retains it on adoption', async () => {
  const { runtime } = createInventoryRuntime(async () => [])
  runtime.workspaceSetupAgentStarts.hold(WORKTREE)
  const held = runtime.workspaceSetupAgentStarts.pending(WORKTREE)
  const claim = runtime.beginPtyRegistration(PTY, undefined, 'native:origin')
  const observed = claim.setupObservation
  expect(observed).toBeDefined()
  const receipt = 'ORCA_SETUP_DONE:native:origin:0;'
  const complete = vi.fn()
  void observed?.completion.then(complete)
  runtime.onPtyData(PTY, receipt, 1, receipt.length, false, receipt.length)
  await Promise.resolve()
  expect(complete).not.toHaveBeenCalled()
  expect(runtime.narrowPtyRegistration(PTY, claim, PREDECESSOR)).toBe(true)
  registerBoundPty(runtime, PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: PREDECESSOR,
    setupCompletionToken: 'native:origin'
  })
  await expect(held).resolves.toBeUndefined()
  await expect(observed?.completion).resolves.toEqual({ exitCode: 0 })
  const adoption = runtime.beginPtyRegistration(PTY, undefined, 'native:discard')
  const discarded = vi.fn()
  void adoption.setupObservation?.completion.then(discarded)
  const tentative = 'ORCA_SETUP_DONE:native:discard:17;'
  runtime.onPtyData(PTY, tentative, 2, tentative.length, false, tentative.length)
  expect(runtime.narrowPtyRegistration(PTY, adoption, PREDECESSOR, true)).toBe(true)
  registerBoundPty(runtime, PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: PREDECESSOR,
    setupCompletionToken: 'native:origin'
  })
  await Promise.resolve()
  expect(discarded).not.toHaveBeenCalled()
  expect(complete).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 })
  const rejected = runtime.beginPtyRegistration(PTY, undefined, 'native:reject')
  runtime.cancelPendingPtyRegistration(PTY, undefined, rejected)
  const replacement = runtime.beginPtyRegistration(PTY, undefined, 'native:replacement')
  expect(replacement.setupObservation).not.toBe(rejected.setupObservation)
  runtime.cancelPendingPtyRegistration(PTY, undefined, replacement)
})

it('keeps a registered gap unknown until the real terminal exit settles its hold', async () => {
  const { runtime } = createInventoryRuntime(async () => [])
  runtime.workspaceSetupAgentStarts.hold(WORKTREE)
  const held = runtime.workspaceSetupAgentStarts.pending(WORKTREE)
  const claim = runtime.beginPtyRegistration(PTY, PREDECESSOR, 'native:gap-exit')
  const observed = claim.setupObservation
  if (!observed) {
    throw new Error('missing spawn observation')
  }
  runtime.notePtyDataGap(PTY)
  const receipt = 'ORCA_SETUP_DONE:native:gap-exit:0;'
  runtime.onPtyData(PTY, receipt, 1, receipt.length, false, receipt.length)
  registerBoundPty(runtime, PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: PREDECESSOR,
    setupCompletionToken: 'native:gap-exit'
  })
  const complete = vi.fn()
  void observed.completion.then(complete)
  await Promise.resolve()
  expect(observed.unknown).toBe(true)
  expect(complete).not.toHaveBeenCalled()
  expect(runtime.workspaceSetupAgentStarts.pending(WORKTREE)).toBe(held)
  await runtime.onPtyExit(PTY, 17, PREDECESSOR, { providerExitObserved: true })
  await expect(observed.completion).resolves.toEqual({ exitCode: 17 })
  await expect(held).resolves.toBeUndefined()
})
