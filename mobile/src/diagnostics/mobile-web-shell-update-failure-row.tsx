import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import type { MobileWebShellUpdateFailure } from '../mobile-web-shell/mobile-web-shell-update-failure'
import { processGenerationStore } from '../mobile-web-shell/process-generation-store'
import { loadHosts } from '../transport/host-store'
import { formatUpdateFailure } from './mobile-web-shell-update-failure-copy'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'

type Line = { readonly hostId: string; readonly text: string }

/** The newest recorded failure of each host still paired, in the host list's order. A host removed
 *  in a build that could not clear its records has no name left to show them under. */
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

/**
 * Why the hybrid shell last failed to update from each host, read off what the shell recorded.
 *
 * The only place a release build shows it: console output never reaches logcat there. Renders
 * nothing until a failure has been recorded, and `app/troubleshoot.tsx` mounts it only in a build
 * that can run the shell.
 */
export function MobileWebShellUpdateFailureRow() {
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
  }, [])

  if (lines.length === 0) {
    return null
  }
  return (
    <View testID="mobile-web-shell-update-failures">
      <Text style={styles.sectionHeading}>Workspace updates</Text>
      <View style={styles.section}>
        <View style={styles.accordionBody}>
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
      </View>
    </View>
  )
}
