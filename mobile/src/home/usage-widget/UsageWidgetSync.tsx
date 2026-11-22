import type { AccountsSnapshot } from '../../accounts/accounts-snapshot'

export type UsageWidgetSyncProps = {
  hosts: readonly { id: string; name: string }[]
  /** True once the desktop list was actually read; a failed read must not look like no desktops. */
  hostsLoaded: boolean
  accountsByHost: Readonly<Record<string, AccountsSnapshot>>
}

// Only iOS has the home screen widget (UsageWidgetSync.ios.tsx); Android and web do nothing.
export function UsageWidgetSync(_props: UsageWidgetSyncProps): null {
  return null
}
