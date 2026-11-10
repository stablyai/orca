import { Text, View } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CloudPhaseSteps } from './CloudPhaseSteps'
import { CloudStatusDot } from './CloudStatusDot'
import { CloudWakeSlowNote } from './CloudWakeSlowNote'
import type { CloudWorkspace } from './cloud-control-plane-client'
import { cloudStatusLabel, formatCloudCost } from './cloud-workspace-display'
import { statusSentence } from './cloud-workspace-copy'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'
import type { CloudWorkspaceRun } from './use-cloud-workspace-run'

/** Spend once, honestly: what it cost so far, and whether it is using sandbox hours now. Plans
 *  include hours, so no per-hour dollar figure is quoted as if it were the meter. */
function spendLine(
  workspace: CloudWorkspace,
  usage: { costCents: number } | null,
  awake: boolean,
  t: Translate
): string | null {
  const usd = usage ? usage.costCents / 100 : (workspace.cost?.usd ?? null)
  if (usd === null) {
    return null
  }
  const cost = formatCloudCost(usd)
  if (!awake) {
    return t('cloud.spend.asleep', '{{cost}} so far · no sandbox hours while asleep', { cost })
  }
  // One sandbox size, so every awake hour counts the same.
  return t('cloud.spend.running', '{{cost}} so far · uses sandbox hours while running', { cost })
}

export function CloudStatusCard(props: {
  workspace: CloudWorkspace
  run: CloudWorkspaceRun
  usage: { costCents: number } | null
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
  const spend = spendLine(workspace, props.usage, awake, t)
  return (
    <View style={styles.statusCard}>
      <View style={styles.statusHeadline}>
        <CloudStatusDot status={active ? 'waking' : workspace.status} warn={notConnected} />
        <Text style={styles.statusLabel} accessibilityRole="header">
          {active
            ? t('cloud.status.waking', 'Waking')
            : notConnected
              ? t('cloud.status.cantConnect', 'Can’t connect')
              : cloudStatusLabel(workspace.status, t)}
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
