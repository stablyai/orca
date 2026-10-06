import type { RuntimePtySpawnState } from './spawn-state'
import { resolveCodexPaneLaunchAccount } from '../../../codex/codex-pane-launch-account'
import { getSystemCodexHomePath } from '../../../codex/codex-home-paths'

export async function selectRuntimeLaunchCodexHome(
  ctx: RuntimePtySpawnState
): Promise<string | null> {
  const { args, deps, codexSelectionTarget, env } = ctx
  const home =
    (args.codexAccountId !== undefined
      ? await deps.getSelectedCodexHomePath?.(codexSelectionTarget, env, {
          pinnedAccountId: args.codexAccountId
        })
      : await deps.getSelectedCodexHomePath?.(codexSelectionTarget, env)) ?? null
  if (args.codexAccountId !== undefined) {
    const settings = deps.getSettings?.()
    const owner =
      home && settings
        ? resolveCodexPaneLaunchAccount({
            pinnedByResume: true,
            launchCodexHomePath: home,
            systemCodexHomePath: getSystemCodexHomePath(),
            settings,
            target: codexSelectionTarget
          })
        : null
    if (!owner || owner.accountId !== args.codexAccountId) {
      throw new Error('The native host could not prepare the pinned Codex account home.')
    }
  }
  return home
}
