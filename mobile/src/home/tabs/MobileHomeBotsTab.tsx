import { Bot, Plus } from '../../components/icons/app-icons'
import { useMemo } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import { MobileBotsListEnd } from '../../bots/MobileBotsSectionHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { HomeBotRow, HomeBots, HomeBotsUnavailable } from '../bots/home-bot-rows'
import { translate } from '../../i18n/mobile-i18n'
import { MobileHomeBotRows } from '../bots/MobileHomeBotRow'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeTabEmpty } from './MobileHomeTabEmpty'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'

/** Every bot on every paired computer and the servers they relay, needs-you first. */
export function MobileHomeBotsTab(props: {
  data: MobileHomeData
  bottomInset: number
  /** Absent when no connected computer takes a new bot. */
  onNewBot?: () => void
  onOpenBot: (row: HomeBotRow) => void
}) {
  const t = useMobileTranslation()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { data } = props
  const header = (
    <MobileHomeTabHeader
      title={t('home.tabs.bots', 'Bots')}
      actions={
        props.onNewBot
          ? [
              {
                id: 'new-bot',
                icon: Plus,
                label: t('bots.new.title', 'New bot'),
                onPress: props.onNewBot
              }
            ]
          : []
      }
    />
  )
  const canCreate = props.onNewBot !== undefined
  const notice = useMemo(() => homeBotsNotice(data.bots, canCreate), [data.bots, canCreate])
  if (!data.hostCatalogLoaded) {
    return header
  }
  const { rows } = data.bots
  // Empty states scroll too, so a native large title sits above them rather than over them.
  return (
    <>
      {header}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          { paddingBottom: props.bottomInset },
          isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
        ]}
      >
        {data.hostCatalog.length === 0 ? (
          <MobileHomeTabEmpty
            icon={Bot}
            title={t('home.bots.noBotsTitle', 'No bots yet')}
            message={t('home.bots.pairDesktop', 'Pair a desktop to see its bots here.')}
          />
        ) : notice.kind === 'empty' ? (
          <MobileHomeTabEmpty icon={Bot} title={notice.title} message={notice.message} />
        ) : (
          <>
            <MobileHomeBotRows rows={rows} onOpen={props.onOpenBot} />
            {notice.kind === 'waiting' ? (
              <View style={styles.connecting}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
              </View>
            ) : notice.lines.length > 0 ? (
              <MobileBotsListEnd lines={notice.lines} underRows={rows.length > 0} />
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  )
}

type HomeBotsNotice =
  | { kind: 'waiting' }
  | { kind: 'empty'; title: string; message: string }
  | { kind: 'lines'; lines: { key: string; text: string }[] }

/** What the tab says beside its rows: a wait for a first answer, one empty state when every computer
 *  is too old or switched off, else a quiet line per computer it can't list. */
export function homeBotsNotice(
  bots: Pick<HomeBots, 'rows' | 'unavailable' | 'listable' | 'awaiting'>,
  canCreate: boolean
): HomeBotsNotice {
  const reasons = bots.unavailable.filter((entry) => entry.reason !== 'no-create')
  if (bots.rows.length === 0 && bots.awaiting) {
    return { kind: 'waiting' }
  }
  const only = reasons[0]?.reason
  if (
    bots.rows.length === 0 &&
    !bots.listable &&
    (only === 'update' || only === 'off') &&
    reasons.every((entry) => entry.reason === only)
  ) {
    return emptyNotice(only, reasons)
  }
  const lines = [
    ...(bots.rows.length === 0
      ? [{ key: 'no-bots', text: translate('bots.list.noBotsYet', 'No bots yet.') }]
      : []),
    ...reasons.map((entry) => ({ key: `${entry.reason}:${entry.key}`, text: endLine(entry) })),
    // + is hidden when nothing takes a bot, so the line says why.
    ...(canCreate
      ? []
      : bots.unavailable
          .filter((entry) => entry.reason === 'no-create')
          .map((entry) => ({ key: `no-create:${entry.key}`, text: endLine(entry) })))
  ]
  return { kind: 'lines', lines }
}

function endLine(entry: HomeBotsUnavailable): string {
  const host = entry.label
  switch (entry.reason) {
    case 'update':
      return translate('bots.list.updateToSee', 'Update Orca on {{host}} to see its bots.', {
        host
      })
    case 'off':
      return translate('bots.list.offEnd', 'Bots are off on {{host}}.', { host })
    case 'unreachable':
      return translate(
        'bots.list.cantReach',
        'Can’t reach {{host}}. Its bots show when it’s back.',
        {
          host
        }
      )
    case 'no-create':
      return translate(
        'bots.list.updateToCreate',
        'Update Orca on {{host}} to make bots from your phone.',
        { host }
      )
  }
}

function emptyNotice(
  reason: 'update' | 'off',
  entries: readonly HomeBotsUnavailable[]
): HomeBotsNotice {
  // Two computers that share a name are still two.
  const one = new Set(entries.map((entry) => entry.key)).size === 1 ? entries[0] : undefined
  if (reason === 'update') {
    return one
      ? {
          kind: 'empty',
          title: translate('bots.list.updateOrcaOn', 'Update Orca on {{host}}', {
            host: one.label
          }),
          message: translate(
            'home.bots.updateOneBody',
            'Its version of Orca can’t show bots on your phone yet.'
          )
        }
      : {
          kind: 'empty',
          title: translate('home.bots.updateManyTitle', 'Update Orca on your computers'),
          message: translate(
            'home.bots.updateManyBody',
            'Their version of Orca can’t show bots on your phone yet.'
          )
        }
  }
  if (!one) {
    return {
      kind: 'empty',
      title: translate('home.bots.offManyTitle', 'Bots are off on your computers'),
      message: translate(
        'home.bots.offManyBody',
        'To turn them on, open Orca on each computer and go to Settings › Bots › Enable bots.'
      )
    }
  }
  return {
    kind: 'empty',
    title: translate('bots.new.botsOffOn', 'Bots are off on {{host}}', { host: one.label }),
    // A server's switch is in its paired computer's Settings › Bots.
    message: one.desktopLabel
      ? translate(
          'home.bots.offServerBody',
          'To turn them on, open Orca on {{desktop}} and go to Settings › Bots › Enable bots on {{host}}.',
          { desktop: one.desktopLabel, host: one.label }
        )
      : translate(
          'home.bots.offOneBody',
          'To turn them on, open Orca on {{host}} and go to Settings › Bots › Enable bots.',
          { host: one.label }
        )
  }
}

const styles = themedStyleSheet(() => ({
  connecting: { alignItems: 'center', paddingVertical: spacing.xl, marginTop: 32 }
}))
