import { Pressable, ScrollView, Text, View } from 'react-native'
import { Copy } from 'lucide-react-native'
import type { AgentCliUpdateAgent } from '../../../../../src/shared/agent-launch/installation/agent-cli-update'
import { AGENT_CLI_PRODUCT_NAMES } from '../../../../../src/shared/agent-launch/installation/agent-cli-product-names'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../../components/sheets/SheetPrimaryButton'
import { ListGroup } from '../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { pressedStyle, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'

export type HostAgentCliUpdateFailure = {
  agent: AgentCliUpdateAgent
  output: string
  command?: string
  /** False when the computer can't run this update itself. */
  retryable: boolean
}

/** What an agent CLI update ran on the computer and what it printed, with one way forward. */
export function HostAgentCliUpdateFailureSheet(props: {
  failure: HostAgentCliUpdateFailure | null
  hostName: string
  online: boolean
  onClose: () => void
  onCopy: (command: string) => void
  onTryAgain: (agent: AgentCliUpdateAgent) => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const { failure } = props
  return (
    <BottomDrawer visible={failure !== null} onClose={props.onClose}>
      {failure ? (
        <View>
          <SheetHeader
            title={t('host.updates.cliFailedTitle', '{{product}} update failed', {
              product: AGENT_CLI_PRODUCT_NAMES[failure.agent]
            })}
            subtitle={props.hostName}
            leading={{ label: t('common.close', 'Close'), onPress: props.onClose }}
          />
          {failure.command ? (
            <ListGroup>
              <Pressable
                style={({ pressed }) => [styles.command, pressed && pressedStyle]}
                onPress={() => props.onCopy(failure.command ?? '')}
                accessibilityRole="button"
                accessibilityLabel={t('host.updates.copyCommand', 'Copy {{command}}', {
                  command: failure.command
                })}
              >
                <Text style={styles.commandText}>{failure.command}</Text>
                <Copy size={17} color={colors.textSecondary} />
              </Pressable>
            </ListGroup>
          ) : null}
          <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
            <Text style={styles.outputText} selectable>
              {failure.output.trim() ||
                t('host.updates.printedNothing', 'The command printed nothing.')}
            </Text>
          </ScrollView>
          <Text style={styles.help}>
            {t(
              'host.updates.cliFailedHelp',
              'Run it yourself on the computer, or fix what it printed and try again.'
            )}
          </Text>
          {failure.retryable ? (
            <View style={styles.footer}>
              <SheetPrimaryButton
                label={t('host.updates.tryAgain', 'Try again')}
                disabled={!props.online}
                onPress={() => props.onTryAgain(failure.agent)}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  command: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  commandText: {
    flex: 1,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary
  },
  output: {
    maxHeight: 260,
    marginTop: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  },
  outputContent: { padding: spacing.lg },
  outputText: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary
  },
  help: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary
  },
  footer: { marginTop: spacing.lg }
}))
