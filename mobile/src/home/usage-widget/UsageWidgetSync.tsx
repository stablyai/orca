import type { AccountsSnapshot } from '../../accounts/accounts-snapshot'

export type UsageWidgetSyncProps = {
  hosts: readonly { id: string; name: string }[]
  hostsLoaded: boolean
  accountsByHost: Readonly<Record<string, AccountsSnapshot>>
}

// Only iOS has the home screen widget (UsageWidgetSync.ios.tsx); Android and web do nothing.
export function UsageWidgetSync(_props: UsageWidgetSyncProps): null {
  return null
}
