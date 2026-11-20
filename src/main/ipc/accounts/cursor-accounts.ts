import { registerAppHandler } from '../app-registry/app-handler-registry'

import { getCursorAccountStatus } from '../../cursor-accounts/status'

export function registerCursorAccountHandlers(): void {
  registerAppHandler('cursorAccounts:getStatus', () => getCursorAccountStatus())
}
