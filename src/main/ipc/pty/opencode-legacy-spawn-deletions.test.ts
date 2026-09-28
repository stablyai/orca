import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'

afterEach(() => vi.unstubAllEnvs())

describe.each(['renderer', 'runtime'])('%s retired OpenCode environment deletion', (route) => {
  it.each([
    { connectionId: undefined, explicit: undefined, deleted: true },
    { connectionId: undefined, explicit: '/user/config', deleted: false },
    { connectionId: 'ssh-host', explicit: undefined, deleted: false }
  ])(
    'respects explicit=$explicit and connection=$connectionId',
    async ({ connectionId, explicit, deleted }) => {
      const legacy = join(getAppEnvironment().getPath('userData'), 'opencode-hooks', 'shared')
      vi.stubEnv('OPENCODE_CONFIG_DIR', legacy)
      const args = { cols: 80, rows: 24, connectionId }
      const env: Record<string, string> = explicit ? { OPENCODE_CONFIG_DIR: explicit } : {}
      let deletions: string[] | undefined
      if (route === 'renderer') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this option-only path reads no required dependency methods with no worktree or hidden pane.
        const ctx = createPtyIpcSpawnState({} as PtySpawnIpcDeps, args)
        ctx.env = env
        ctx.isDaemonHostSpawn = !connectionId
        await buildPtyIpcSpawnOptions(ctx)
        deletions = ctx.spawnOptions.envToDelete
        ctx.finishTerminalInstall()
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this option-only path reads no required dependency methods with no worktree or hidden pane.
        const ctx = createRuntimePtySpawnState({} as PtyRuntimeControllerDeps, args)
        ctx.env = env
        ctx.isDaemonHostSpawn = !connectionId
        await buildRuntimePtySpawnOptions(ctx)
        deletions = ctx.spawnOptions.envToDelete
        ctx.finishTerminalInstall()
      }
      expect(deletions?.includes('OPENCODE_CONFIG_DIR') ?? false).toBe(deleted)
      expect(env.OPENCODE_CONFIG_DIR).toBe(explicit)
    }
  )
})
