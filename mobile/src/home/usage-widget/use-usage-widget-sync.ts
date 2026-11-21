import { useEffect, useRef } from 'react'
import type { AccountsSnapshot } from '../../accounts/accounts-snapshot'
import { useUsagePercentageDisplay } from '../../accounts/usage/usage-percentage-display-preference'
import { buildUsageWidgetSummary, parseUsageWidgetSummary } from './usage-widget-summary'
import { usageWidgetStorage } from './usage-widget-storage'

/** Hands Home's live usage to the iOS widget; the widget never talks to a desktop itself. */
export function useUsageWidgetSync(input: {
  hosts: readonly { id: string; name: string }[]
  hostsLoaded: boolean
  accountsByHost: Readonly<Record<string, AccountsSnapshot>>
}): void {
  const display = useUsagePercentageDisplay()
  const lastWrittenRef = useRef<string | null | undefined>(undefined)
  const { hosts, hostsLoaded, accountsByHost } = input
  useEffect(() => {
    // An unloaded desktop list would read as "all unpaired" and wipe the widget.
    if (!usageWidgetStorage || !hostsLoaded) {
      return
    }
    try {
      if (lastWrittenRef.current === undefined) {
        lastWrittenRef.current = usageWidgetStorage.read()
      }
      const next = JSON.stringify(
        buildUsageWidgetSummary({
          hosts,
          liveSnapshots: accountsByHost,
          previous: parseUsageWidgetSummary(lastWrittenRef.current),
          display
        })
      )
      if (next !== lastWrittenRef.current) {
        usageWidgetStorage.write(next)
        lastWrittenRef.current = next
      }
    } catch (error) {
      console.warn('Usage widget could not be updated', error)
    }
  }, [hosts, hostsLoaded, accountsByHost, display])
}
