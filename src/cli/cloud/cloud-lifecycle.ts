// Private build only: `orca cloud workspace sleep|wake|archive|destroy`. Wake and sleep show
// progress on stderr (see cloud-progress.ts) so a multi-second wait is never silent.
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { formatCloudWorkspace, printCloudResult, type CloudWorkspace } from './cloud-format'
import {
  MUTATE_TIMEOUT_MS,
  cloudClient,
  resolveCloudWorkspaceId,
  workspacePath,
  type CloudHandlerDeps
} from './cloud-operations'
import { cloudProgress, readCloudProgressMode } from './cloud-progress'

export type CloudLifecycleAction = 'sleep' | 'wake' | 'archive' | 'destroy'

export function cloudLifecycleHandler(
  action: CloudLifecycleAction,
  getDeps: () => CloudHandlerDeps
): CommandHandler {
  return async ({ flags, json }) => {
    const deps = getDeps()
    const selector = getRequiredStringFlag(flags, 'workspace')
    // Waking and sleeping take seconds: always show that something is happening (stderr).
    const shown = action === 'wake' || action === 'sleep'
    const progress = cloudProgress(shown ? readCloudProgressMode(flags, json) : 'none')
    const api = cloudClient(deps)
    const id = await resolveCloudWorkspaceId(api, selector)
    if (action === 'wake') {
      progress.phase('waking', `Waking ${selector}...`, { workspaceId: id })
    } else if (action === 'sleep') {
      progress.phase('sleeping', `Putting ${selector} to sleep...`, { workspaceId: id })
    }
    const started = deps.now()
    const request = api.request<{ workspace: CloudWorkspace; state?: string }>(
      action === 'destroy' ? 'DELETE' : 'POST',
      action === 'destroy' ? workspacePath(id) : workspacePath(id, `/${action}`),
      { timeoutMs: MUTATE_TIMEOUT_MS }
    )
    const result =
      action === 'wake'
        ? await progress.track(
            request,
            (s) => `Still waking (${s}s). This is taking longer than usual; your files are safe.`
          )
        : await request
    const name = result.workspace.name || selector
    // The API's wake waits ~30 s; past that it answers `waking` and keeps going in the background.
    const stillWaking =
      action === 'wake' && (result.state === 'waking' || result.workspace.status === 'waking')
    if (stillWaking) {
      result.workspace = { ...result.workspace, status: 'waking' }
      progress.phase(
        'still-waking',
        `${name} is still waking. Check with: orca cloud workspace show ${id}`,
        { workspaceId: id }
      )
    } else if (action === 'wake') {
      progress.phase('awake', `${name} is awake (took ${progress.elapsedSeconds()}s).`, {
        workspaceId: id
      })
    } else if (action === 'sleep') {
      progress.phase('asleep', `${name} is asleep (took ${progress.elapsedSeconds()}s).`, {
        workspaceId: id
      })
    }
    printCloudResult({ ...result, elapsedMs: deps.now() - started }, json, (value) =>
      formatCloudWorkspace(value)
    )
  }
}
