import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostAccountsOperations } from './host-accounts-operations'

export function webHostAccountsOperations(
  client: MobileWebBridgeClient,
  hostName: string
): HostAccountsOperations {
  return {
    async loadHostName() {
      return hostName
    },
    snapshot() {
      return client.account.snapshot()
    },
    async select(provider, accountId, codexTarget) {
      await client.account.select({
        provider,
        accountId,
        ...(provider === 'codex' && codexTarget ? { codexTarget } : {})
      })
    },
    readCodexResetCreditCapability() {
      return client.account.resetCreditCapability()
    },
    consumeCodexResetCredit(expectedScope) {
      return client.account.consumeResetCredit({ expectedScope })
    },
    subscribe(listener, onInvalid) {
      const subscription = client.account.subscribe(
        (event) => {
          if (event.type === 'ready' || event.type === 'snapshot') {
            listener(event.snapshot)
          }
        },
        () => onInvalid?.()
      )
      void subscription.ready.catch(() => {})
      return subscription.unsubscribe
    }
  }
}
