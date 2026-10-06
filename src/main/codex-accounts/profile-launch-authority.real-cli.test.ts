// Opt-in protocol compatibility evidence uses an empty home inside a disposable Linux container.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { CODEX_PROFILE_FILE_AUTH_ARGS } from './profile-config-authority'
import { observeCodexProfileLaunchAuthority } from './profile-launch-authority'

it.skipIf(process.env.ORCA_PROFILE_PROTOCOL_SMOKE !== '1')(
  'accepts the installed Codex inspection protocol and refuses a logged-out managed identity',
  async () => {
    expect(process.platform).toBe('linux')
    expect(existsSync('/.dockerenv')).toBe(true)
    const executable = process.env.ORCA_PROFILE_PROTOCOL_CLI
    if (!executable) {
      throw new Error('Set ORCA_PROFILE_PROTOCOL_CLI to the pinned container-local Codex CLI')
    }
    const root = mkdtempSync(join(tmpdir(), 'orca-profile-protocol-'))
    const home = join(root, 'home')
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome, { recursive: true })
    const env = { HOME: home, CODEX_HOME: codexHome }
    try {
      await runCodexAppServerSession(
        {
          command: executable,
          cliPath: executable,
          cwd: root,
          args: [...CODEX_PROFILE_FILE_AUTH_ARGS, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
          env,
          timeoutMs: 8000,
          maxOutputBytes: 1024 * 1024
        },
        async (rpc) => {
          const config = await rpc.request('config/read', { cwd: root, includeLayers: true })
          expect(config).toMatchObject({
            // The inspection protocol preserves an omitted provider instead of materializing its default.
            config: { model_provider: null, cli_auth_credentials_store: 'file' },
            origins: expect.any(Object),
            layers: expect.any(Array)
          })
          expect(await rpc.request('configRequirements/read', {})).toEqual({ requirements: null })
          expect(await rpc.request('account/read', { refreshToken: false })).toMatchObject({
            account: null,
            requiresOpenaiAuth: true,
            workspaceRouting: null
          })
        }
      )
      await expect(
        observeCodexProfileLaunchAuthority({
          snapshot: {
            id: 'synthetic',
            name: 'Synthetic',
            agent: 'codex',
            hostId: 'local',
            executable,
            binding: { kind: 'managed', accountId: 'synthetic' },
            resolvedHome: codexHome,
            identity: {
              kind: 'verified',
              subject: 'synthetic',
              displayName: 'synthetic@example.invalid'
            }
          },
          cwd: root,
          env
        })
      ).rejects.toMatchObject({ code: 'codex_policy' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  25_000
)
