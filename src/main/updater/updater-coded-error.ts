import {
  updaterCodedMessage,
  type UpdaterCodedMessage,
  type UpdaterFailureCode,
  type UpdaterFailureParams
} from '../../shared/updater-failure-copy'
import { errorMessage } from '../../shared/error-message'

/** Thrown inside main only; handlers copy its code onto the status or IPC result. */
export class UpdaterCodedError extends Error {
  readonly coded: UpdaterCodedMessage

  constructor(code: UpdaterFailureCode, params?: UpdaterFailureParams) {
    const coded = updaterCodedMessage(code, params)
    super(coded.message)
    this.coded = coded
  }
}

export function updaterErrorMessage(error: unknown): UpdaterCodedMessage {
  return error instanceof UpdaterCodedError ? error.coded : { message: errorMessage(error) }
}
