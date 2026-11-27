import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import type { MobileWebShellUpdateFailure } from '../mobile-web-shell/update-recovery/mobile-web-shell-update-failure'
import { processGenerationStore } from '../mobile-web-shell/generations/process-generation-store'
import { loadHosts } from '../host-catalog/host-store'
import { formatUpdateFailure } from './mobile-web-shell-update-failure-copy'
import { troubleshootScreenStylesSheet } from './troubleshoot-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import { useThemedStyles } from '../theme/themed-styles'

type Line = { readonly hostId: string; readonly text: string }

// Ignore orphaned records from hosts no longer paired; they have no host name to display.
export function updateFailureLines(
  failures: readonly MobileWebShellUpdateFailure[],
  hosts: readonly { id: string; name: string }[],
  now: number
): Line[] {
  return hosts.flatMap((host) => {
    const newest = failures.findLast((failure) => failure.hostId === host.id)
    return newest === undefined
      ? []
      : [{ hostId: host.id, text: formatUpdateFailure(newest, host.name, now) }]
  })
}

// Release console output never reaches logcat; this row is the only update-failure evidence visible there. Mount only in shell-capable builds.
export function MobileWebShellUpdateFailureRow() {
  const styles = useThemedStyles(troubleshootScreenStylesSheet)
  const t = useMobileTranslation()
  const [lines, setLines] = useState<readonly Line[]>([])

  useEffect(() => {
    let stale = false
    void Promise.all([processGenerationStore().readUpdateFailures(), loadHosts()])
      .then(([failures, hosts]) => {
        if (!stale) {
          setLines(updateFailureLines(failures, hosts, Date.now()))
        }
      })
      // Evidence, not a feature: an unreadable log or host list shows nothing rather than an error.
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [t])

  if (lines.length === 0) {
    return null
  }
  return (
    <View testID="mobile-web-shell-update-failures">
      <SectionHeader
        title={t('diagnostics.mobileWebShellUpdateFailureRow.title', 'Workspace updates')}
        first
      />
      <ListGroup style={styles.group}>
        <View key="lines" style={styles.noteBody}>
          {lines.map((line) => (
            <Text
              key={line.hostId}
              style={styles.stepText}
              testID="mobile-web-shell-update-failure"
            >
              {line.text}
            </Text>
          ))}
        </View>
      </ListGroup>
    </View>
  )
}
