import { ptySpawnPaneFromIds, stampPtySpawnPaneEnv } from '../ipc/pty/spawn-pane-env'
import { buildJcodeRuntimeDirEnv, JCODE_RUNTIME_DIR_ENV_KEY } from '../../shared/jcode-runtime-dir'

/** Reconstructs identity formulas from fake spawn args; wiring and directory readiness need real-path tests. */
export function spawnedPtyEnv(call: unknown): Record<string, string> {
  const values: Record<string, unknown> =
    typeof call === 'object' && call !== null ? { ...call } : {}
  const env: Record<string, string> = {}
  if (typeof values.env === 'object' && values.env !== null) {
    for (const [key, value] of Object.entries(values.env)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }
  }
  const pane = ptySpawnPaneFromIds({
    tabId: typeof values.tabId === 'string' ? values.tabId : undefined,
    leafId: typeof values.leafId === 'string' ? values.leafId : undefined,
    worktreeId: typeof values.worktreeId === 'string' ? values.worktreeId : undefined
  })
  stampPtySpawnPaneEnv(env, {
    pane,
    jcodeRuntimeDir: pane
      ? buildJcodeRuntimeDirEnv(pane.paneKey)?.[JCODE_RUNTIME_DIR_ENV_KEY]
      : undefined
  })
  return env
}
