import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'workspace-1'
/** The shared-home layout `isLegacySharedCodexHome` matches; anything else returns before sending. */
const LEGACY_CODEX_HOME = '/hosts/codex-runtime-home/home'

/**
 * Resuming a sleeping agent: the legacy-Codex repin the phone asks for first, then the create/send
 * pair that puts the resume command in a terminal. Both are exported async functions taking a
 * client, so the recorded state is each function's own answer and no React host is needed.
 */
export function aiVaultResumeMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'aiVault.resume-preparation': ({ client }) => {
      const prepare = modules.load<typeof import('../../../session/ai-vault-resume-preparation')>(
        'mobile/src/session/ai-vault-resume-preparation.ts'
      ).prepareMobileAiVaultSessionResume
      let prepared: unknown = 'unprepared'
      let failure: unknown = null
      return {
        action: (name) =>
          prepare(
            client,
            mountFixture<Parameters<typeof prepare>[1]>({
              // `claude` never reaches the wire: the preparation is Codex-only and returns first.
              agent: name === 'claude' ? 'claude' : 'codex',
              filePath: '/sessions/rollout.jsonl',
              codexHome: LEGACY_CODEX_HOME,
              executionHostId: 'local'
            })
          ).then(
            (value: unknown) => {
              prepared = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ prepared, failure }),
        dispose: () => {}
      }
    },
    'aiVault.resume-launch': ({ client }) => {
      const resume = modules.load<typeof import('../../../session/ai-vault-resume-launch')>(
        'mobile/src/session/ai-vault-resume-launch.ts'
      ).resumeAiVaultSessionInTerminal
      let launched: unknown = 'unlaunched'
      let failure: unknown = null
      return {
        action: (name) =>
          resume(
            client,
            WORKTREE,
            mountFixture<Parameters<typeof resume>[2]>({
              command: 'codex resume rollout',
              // The bare arm drops every optional launch field, which changes the create params.
              ...(name === 'bare'
                ? {}
                : {
                    env: { ORCA_RESUME: '1' },
                    envToDelete: ['CODEX_HOME'],
                    launchAgent: 'codex',
                    clientMutationId: 'resume-mutation-1'
                  })
            })
          ).then(
            (value: unknown) => {
              launched = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ launched, failure }),
        dispose: () => {}
      }
    }
  }
}
