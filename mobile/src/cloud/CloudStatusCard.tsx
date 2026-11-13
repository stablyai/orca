import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CloudPhaseSteps } from './CloudPhaseSteps'
import { CloudStatusDot } from './CloudStatusDot'
import { CloudWakeSlowNote } from './CloudWakeSlowNote'
import type { CloudWorkspace } from './cloud-control-plane-client'
import { cloudSpendLine, cloudStatusLabel } from './cloud-workspace-display'
import { statusSentence } from './cloud-workspace-copy'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'
import type { CloudWorkspaceRun } from './use-cloud-workspace-run'

export function CloudStatusCard(props: {
  workspace: CloudWorkspace
  run: CloudWorkspaceRun
  usage: { totalMs: number } | null
  uptimeMs: number | null
  /** Shows the "start the agent" step only when a prompt is actually waiting. */
  promptsWaiting: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { workspace, run } = props
  const active = run.kind === 'attaching' || run.kind === 'delivering'
  // Up but unreachable from this phone: a filled amber dot, as a desktop that can't connect.
  const notConnected = run.kind === 'error' && workspace.status === 'running'
  const awake = active || workspace.status === 'running' || workspace.status === 'creating'
  const spend = cloudSpendLine(workspace, props.usage, awake, t)
  return (
    <View style={styles.statusCard}>
      <View style={styles.statusHeadline}>
        <CloudStatusDot status={active ? 'waking' : workspace.status} warn={notConnected} />
        <Text style={styles.statusLabel} accessibilityRole="header">
          {/* Only glossary states: a running workspace this phone can't reach still reads
              "Running" (with the warning dot); the error banner below says what went wrong. */}
          {active ? t('cloud.status.waking', 'Waking') : cloudStatusLabel(workspace.status, t)}
        </Text>
      </View>
      {active ? (
        <>
          <CloudPhaseSteps
            phase={run.kind === 'attaching' ? run.phase : 'delivering'}
            since={run.startedAt}
            delivering={run.kind === 'delivering' || props.promptsWaiting}
          />
          {/* Counted from the run's start, which is also the wake step's start. */}
          <CloudWakeSlowNote
            key={run.startedAt}
            since={run.startedAt}
            waking={run.kind === 'attaching' && run.phase === 'waking'}
            promptQueued={props.promptsWaiting}
          />
        </>
      ) : notConnected ? null : (
        // Not connected: the error banner right below says it, once.
        <Text style={styles.statusLine}>{statusSentence(workspace, t, props.uptimeMs)}</Text>
      )}
      {spend ? <Text style={styles.statusSpend}>{spend}</Text> : null}
    </View>
  )
}
