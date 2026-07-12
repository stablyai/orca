import type { TransferProfileState } from './profile-project-state-file'
import type { TransferPayload } from './profile-project-transfer-payload'

/**
 * Why: a profile transfer rebuilds the target project projection-fresh, which
 * drops project-scoped settings. Re-stamp the carried runtime preference and
 * default shell onto the transferred project so a WSL project keeps routing.
 */
export function applyTransferredProjectSettings(
  state: TransferProfileState,
  payload: TransferPayload
): TransferProfileState {
  if (payload.localWindowsRuntimePreference === undefined && payload.defaultShell === undefined) {
    return state
  }
  const targetProjectId = payload.targetProjectId
  if (!targetProjectId) {
    return state
  }
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === targetProjectId
        ? {
            ...project,
            ...(payload.localWindowsRuntimePreference !== undefined
              ? { localWindowsRuntimePreference: payload.localWindowsRuntimePreference }
              : {}),
            ...(payload.defaultShell !== undefined ? { defaultShell: payload.defaultShell } : {})
          }
        : project
    )
  }
}
