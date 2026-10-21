import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

/** Why: the renderer's `pty:spawn` handler builds options here, not through the
 *  runtime controller — the configured profile has to reach both. */
async function resolveSpawnShellArgs(
  args: PtySpawnIpcArgs,
  settings: { terminalDefaultShell?: string; terminalDefaultShellArgs?: string[] }
): Promise<string[] | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    getSettings: () => ({ ...getDefaultSettings('/tmp'), ...settings }),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = {}
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions.terminalShellArgs
}

const PANE = { cols: 80, rows: 24 }

describe('renderer pty spawn: configured Unix shell arguments', () => {
  it('forwards an explicit empty argument list to the provider', async () => {
    await expect(
      resolveSpawnShellArgs(PANE, {
        terminalDefaultShell: '/bin/bash',
        terminalDefaultShellArgs: []
      })
    ).resolves.toEqual([])
  })

  it('forwards custom arguments to the provider', async () => {
    await expect(
      resolveSpawnShellArgs(PANE, {
        terminalDefaultShell: '/bin/bash',
        terminalDefaultShellArgs: ['--rcfile', '/tmp/rc']
      })
    ).resolves.toEqual(['--rcfile', '/tmp/rc'])
  })

  it('leaves the controlled login default alone when no profile is configured', async () => {
    await expect(
      resolveSpawnShellArgs(PANE, { terminalDefaultShell: '/bin/bash' })
    ).resolves.toBeUndefined()
  })

  it('does not apply the profile to a one-off shell selection', async () => {
    await expect(
      resolveSpawnShellArgs(
        { ...PANE, shellOverride: '/bin/fish' },
        { terminalDefaultShell: '/bin/bash', terminalDefaultShellArgs: [] }
      )
    ).resolves.toBeUndefined()
  })
})
