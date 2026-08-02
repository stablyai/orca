import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import { isCommandOnPath } from '../ipc/preflight-command-exec'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { mergePersistedWindowsPathAsync } from '../pty/windows-environment-path'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'

export async function isNpxOnPathForSkillInstall(
  context?: PreflightRuntimeContext,
  options?: { forceRefresh?: boolean }
): Promise<boolean> {
  const wslTarget = getPreflightWslTarget(context) ?? undefined
  if (wslTarget) {
    return isCommandOnPath('npx', wslTarget)
  }
  const forceRefresh = options?.forceRefresh ?? false
  await (process.platform === 'win32'
    ? mergePersistedWindowsPathAsync(process.env, { forceRefresh })
    : preparePosixHostPath(context, forceRefresh))
  return isCommandOnPath('npx', wslTarget)
}

async function preparePosixHostPath(
  context: PreflightRuntimeContext | undefined,
  forceRefresh: boolean
): Promise<void> {
  if (!forceRefresh) {
    await hydrateShellPathForAgentDetection(context)
    return
  }
  const hydration = await hydrateShellPath({ force: true })
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}
