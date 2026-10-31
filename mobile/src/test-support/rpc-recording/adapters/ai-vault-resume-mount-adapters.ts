import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'workspace-1'
// Use a path accepted by the legacy shared-Codex-home guard so preparation can reach the wire.
const LEGACY_CODEX_HOME = '/hosts/codex-runtime-home/home'

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
