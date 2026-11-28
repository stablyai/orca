import { ActivityIndicator, Pressable } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import type { AgentCliUpdateHostRow } from '../../../../../src/shared/agent-launch/installation/agent-cli-update-runs'
import { AGENT_CLI_PRODUCT_NAMES } from '../../../../../src/shared/agent-launch/installation/agent-cli-product-names'
import { ListRow } from '../../../components/list/ListGroup'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import { MobileBotTextButton } from '../../../bots/MobileBotTextButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'

/** One agent CLI on the computer: what's out, its update as it runs, or the command to run by hand. */
export function HostAgentCliUpdateRow(props: {
  row: AgentCliUpdateHostRow
  /** The version it reached on this visit, once updated. */
  updatedTo: string | undefined
  online: boolean
  onUpdate: () => void
  onCopy: (command: string) => void
  onOpenFailure: () => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const { row } = props
  const product = AGENT_CLI_PRODUCT_NAMES[row.agent]
  const leading = <MobileAgentIcon agentId={row.agent} size={20} />
  if (props.updatedTo !== undefined) {
    return (
      <ListRow
        title={product}
        leading={leading}
        subtitle={
          props.updatedTo
            ? t('host.updates.updatedTo', 'Updated to {{version}}', { version: props.updatedTo })
            : t('host.updates.updated', 'Updated')
        }
        accessory={<Check size={17} color={colors.textSecondary} strokeWidth={2.2} />}
      />
    )
  }
  const run = row.run
  if (run?.phase === 'running' || run?.phase === 'queued') {
    return (
      <ListRow
        title={product}
        leading={leading}
        subtitle={
          run.phase === 'running'
            ? t('host.updates.updating', 'Updating…')
            : t('host.updates.queued', 'Queued')
        }
        accessory={
          run.phase === 'running' ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : undefined
        }
      />
    )
  }
  if (run?.phase === 'failed') {
    return (
      <ListRow
        title={product}
        leading={leading}
        subtitle={t('host.updates.updateFailed', 'Update failed')}
        subtitleColor={colors.statusRed}
        onPress={props.onOpenFailure}
        accessory={
          row.update?.runnable ? (
            <MobileBotTextButton
              accent
              label={t('host.updates.tryAgain', 'Try again')}
              disabled={!props.online}
              onPress={props.onUpdate}
            />
          ) : undefined
        }
      />
    )
  }
  const update = row.update
  if (!update) {
    return null
  }
  if (!update.runnable) {
    // People read a command before they run it, so it wraps instead of truncating.
    return (
      <ListRow
        title={product}
        leading={leading}
        subtitle={update.command}
        subtitleMono
        subtitleLines={4}
        onPress={() => props.onCopy(update.command)}
        accessibilityLabel={t('host.updates.copyCommand', 'Copy {{command}}', {
          command: update.command
        })}
        accessory={
          <Pressable hitSlop={8} onPress={() => props.onCopy(update.command)}>
            <Copy size={17} color={colors.textSecondary} />
          </Pressable>
        }
      />
    )
  }
  const versions = t('host.updates.versions', '{{installed}} → {{latest}}', {
    installed: update.installedVersion,
    latest: update.latestVersion
  })
  const models = update.models?.map((model) => model.name).join(', ')
  return (
    <ListRow
      title={product}
      leading={leading}
      subtitle={
        models
          ? t('host.updates.addsModels', '{{versions}} · adds {{models}}', { versions, models })
          : versions
      }
      value={t('host.updates.update', 'Update')}
      valueColor={colors.accentBlue}
      disabled={!props.online}
      onPress={props.onUpdate}
    />
  )
}
