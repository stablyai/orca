import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

async function resolveSpawnOptions(args: PtySpawnIpcArgs) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    getSettings: () => getDefaultSettings('/tmp'),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = {}
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions
}

async function resolveSpawnIntent(args: PtySpawnIpcArgs): Promise<unknown> {
  return (await resolveSpawnOptions(args)).spawnIntent
}

const PANE = { cols: 80, rows: 24 }

describe('renderer pty spawn: declared spawn intent', () => {
  it('treats a missing or unknown intent as undeclared', async () => {
    await expect(resolveSpawnIntent(PANE)).resolves.toBeUndefined()
    await expect(resolveSpawnIntent({ ...PANE, spawnIntent: 'urgent' })).resolves.toBeUndefined()
    await expect(
      resolveSpawnIntent({ ...PANE, spawnIntent: 'interactive' })
    ).resolves.toBeUndefined()
  })
})

describe('renderer pty spawn: a passive restore', () => {
  it('forwards only an exact true, which lets the WSL host hold a stopped distro', async () => {
    expect(
      (await resolveSpawnOptions({ ...PANE, wslPassiveRestore: true })).wslPassiveRestore
    ).toBe(true)
    expect(
      (await resolveSpawnOptions({ ...PANE, wslPassiveRestore: 'yes' })).wslPassiveRestore
    ).toBeUndefined()
    expect((await resolveSpawnOptions(PANE)).wslPassiveRestore).toBeUndefined()
  })
})
