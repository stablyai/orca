import { registerAppHandler } from '../app-registry/app-handler-registry'

import { getGrokAccountStatus } from '../../grok-accounts/status'

export function registerGrokAccountHandlers(): void {
  registerAppHandler('grokAccounts:getStatus', () => getGrokAccountStatus())
}
