import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createDaemonPtyEnvironment } from '../../daemon/pty-subprocess/spawn-environment'
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
    { connectionId: undefined, daemon: false, explicit: undefined, deleted: true },
    { connectionId: undefined, daemon: true, explicit: undefined, deleted: false },
    { connectionId: undefined, daemon: true, explicit: '/user/config', deleted: false },
    { connectionId: 'ssh-host', daemon: false, explicit: undefined, deleted: false }
  ])(
    'respects explicit=$explicit, daemon=$daemon, and connection=$connectionId',
    async ({ connectionId, daemon, explicit, deleted }) => {
      const legacy = join(getAppEnvironment().getPath('userData'), 'opencode-hooks', 'shared')
      vi.stubEnv('OPENCODE_CONFIG_DIR', legacy)
      const args = { cols: 80, rows: 24, connectionId }
      const env: Record<string, string> = explicit ? { OPENCODE_CONFIG_DIR: explicit } : {}
      let deletions: string[] | undefined
      if (route === 'renderer') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this option-only path reads no required dependency methods with no worktree or hidden pane.
        const ctx = createPtyIpcSpawnState({} as PtySpawnIpcDeps, args)
        ctx.env = env
        ctx.isDaemonHostSpawn = daemon
        await buildPtyIpcSpawnOptions(ctx)
        deletions = ctx.spawnOptions.envToDelete
        ctx.finishTerminalInstall()
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this option-only path reads no required dependency methods with no worktree or hidden pane.
        const ctx = createRuntimePtySpawnState({} as PtyRuntimeControllerDeps, args)
        ctx.env = env
        ctx.isDaemonHostSpawn = daemon
        await buildRuntimePtySpawnOptions(ctx)
        deletions = ctx.spawnOptions.envToDelete
        ctx.finishTerminalInstall()
      }
      expect(deletions?.includes('OPENCODE_CONFIG_DIR') ?? false).toBe(deleted)
      expect(env.OPENCODE_CONFIG_DIR).toBe(explicit)
      if (daemon) {
        vi.stubEnv('ORCA_USER_DATA_PATH', getAppEnvironment().getPath('userData'))
        for (const inherited of [legacy, '/daemon/user-config']) {
          vi.stubEnv('OPENCODE_CONFIG_DIR', inherited)
          const request = { sessionId: 'pane', cols: 80, rows: 24, env, envToDelete: deletions }
          const result = createDaemonPtyEnvironment(request)
          expect(result.OPENCODE_CONFIG_DIR).toBe(
            explicit ?? (inherited === legacy ? undefined : inherited)
          )
          expect(
            createDaemonPtyEnvironment({ ...request, envToDelete: ['OPENCODE_CONFIG_DIR'] })
              .OPENCODE_CONFIG_DIR
          ).toBeUndefined()
        }
      }
    }
  )
})
