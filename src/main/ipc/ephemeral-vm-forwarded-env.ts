import { app, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  summarizeRecipeForwardedEnv,
  type RecipeForwardedEnvSummary
} from '../../shared/ephemeral-vm-recipe-forwarded-env'
import { getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'

/** Which recipe host the renderer asks about. Main looks its recipe up; it never takes a passEnv. */
export type RecipeForwardedEnvSummaryArgs = { environmentId?: string }

/** The recipe's passEnv as its lifecycle scripts get it; undefined (whole env) when unresolvable. */
export function resolveRecipeHostPassEnv(
  store: Store,
  userDataPath: string,
  environmentId: unknown
): readonly string[] | undefined {
  if (typeof environmentId !== 'string' || environmentId.length === 0) {
    return undefined
  }
  try {
    const runtime = listEphemeralVmRuntimes(userDataPath).find(
      (entry) => entry.runtimeEnvironmentId === environmentId
    )
    return runtime
      ? getRuntimeRecipeContext(store, userDataPath, runtime.id).recipe.passEnv
      : undefined
  } catch {
    // Why: an unresolvable recipe falls back to the whole env, which can only over-warn.
    return undefined
  }
}

/** Recipe scripts inherit this process's env (buildRecipeEnv); only the names cross to the renderer. */
export function registerRecipeForwardedEnvHandler(store: Store): void {
  ipcMain.removeHandler('ephemeralVm:forwardedEnvSummary')
  ipcMain.handle(
    'ephemeralVm:forwardedEnvSummary',
    (_event, args?: RecipeForwardedEnvSummaryArgs): RecipeForwardedEnvSummary =>
      summarizeRecipeForwardedEnv(
        process.env,
        resolveRecipeHostPassEnv(store, app.getPath('userData'), args?.environmentId)
      )
  )
}
