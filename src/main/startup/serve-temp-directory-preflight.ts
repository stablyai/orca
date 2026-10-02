import { app } from 'electron'
import { SERVE_SUPERVISOR_STOP_EXIT_CODE } from '../../shared/serve-supervision'
import {
  prepareServeTempDirectory,
  ServeTempDirectoryError
} from '../../shared/serve-temp-directory'

export function validateServeTempDirectory(): boolean {
  try {
    prepareServeTempDirectory()
    return true
  } catch (error) {
    if (!(error instanceof ServeTempDirectoryError)) {
      throw error
    }
    console.error(`[serve] ${error.message}`)
    app.exit(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    return false
  }
}
