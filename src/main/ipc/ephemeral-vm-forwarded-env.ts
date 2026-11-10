import { ipcMain } from 'electron'
import {
  summarizeRecipeForwardedEnv,
  type RecipeForwardedEnvSummary
} from '../../shared/ephemeral-vm-recipe-forwarded-env'

/** Recipe scripts inherit this process's env (buildRecipeEnv); only the names cross to the renderer. */
export function registerRecipeForwardedEnvHandler(): void {
  ipcMain.removeHandler('ephemeralVm:forwardedEnvSummary')
  ipcMain.handle('ephemeralVm:forwardedEnvSummary', (): RecipeForwardedEnvSummary =>
    summarizeRecipeForwardedEnv(process.env)
  )
}
