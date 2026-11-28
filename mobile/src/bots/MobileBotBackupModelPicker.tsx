// Searchable picker for choosing a bot backup model grouped by agent on mobile.
import { useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  botModelTargetKey,
  type BotBackupCatalogOption,
  type BotBackupModelEntry
} from '../../../src/shared/bots/bot-backup-models'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { spacing } from '../theme/mobile-theme'
import { botAgentLabel } from './mobile-bot-sheet-copy'

export function MobileBotBackupModelPicker(props: {
  options: readonly BotBackupCatalogOption[]
  catalogState: 'ready' | 'loading' | 'unavailable'
  onRetry: () => void
  excludedKeys: ReadonlySet<string>
  disabled: boolean
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  onPick: (entry: BotBackupModelEntry) => void
}) {
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [pendingOption, setPendingOption] = useState<BotBackupCatalogOption | null>(null)
  const trimmed = query.trim().toLowerCase()

  const grouped = useMemo(() => {
    const groups = new Map<string, BotBackupCatalogOption[]>()
    for (const option of props.options) {
      if (props.excludedKeys.has(botModelTargetKey(option))) {
        continue
      }
      if (trimmed) {
        const hay =
          `${option.agent} ${botAgentLabel(option.agent)} ${option.model ?? ''} ${option.label}`.toLowerCase()
        if (!hay.includes(trimmed)) {
          continue
        }
      }
      const list = groups.get(option.agent) ?? []
      list.push(option)
      groups.set(option.agent, list)
    }
    return [...groups.entries()]
  }, [props.options, props.excludedKeys, trimmed])

  if (pendingOption?.efforts?.length) {
    const commit = (effort?: string) => {
      const target = pendingOption
      setPendingOption(null)
      props.onPick({
        agent: target.agent,
        ...(target.model ? { model: target.model } : {}),
        ...(effort ? { options: { effort } } : {})
      })
    }
    return (
      <>
        <SheetHeader
          title={t('bots.settings.backupModelsReasoningEffort', 'Reasoning effort')}
          onBack={{
            label: t('bots.settings.backupModelsAdd', 'Add backup model'),
            onPress: () => setPendingOption(null)
          }}
        />
        {props.banner}
        <SettingsSection title={`${botAgentLabel(pendingOption.agent)} · ${pendingOption.label}`}>
          <ListRow
            title={t('bots.settings.backupModelsDefaultEffort', 'Default')}
            disabled={props.disabled}
            onPress={() => commit()}
            accessibilityRole="button"
          />
          {pendingOption.efforts.map((choice) => (
            <ListRow
              key={choice.value}
              title={choice.label}
              disabled={props.disabled}
              onPress={() => commit(choice.value)}
              accessibilityRole="button"
            />
          ))}
        </SettingsSection>
      </>
    )
  }

  return (
    <>
      <SheetHeader
        title={t('bots.settings.backupModelsAdd', 'Add backup model')}
        onBack={props.onBack}
      />
      {props.banner}
      <View style={styles.searchWrap}>
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('bots.settings.backupModelsSearch', 'Search models…')}
          editable={!props.disabled}
        />
      </View>
      {props.catalogState === 'unavailable' ? (
        <SettingsSection>
          <ListRow
            title={t('bots.settings.backupModelsCatalogRetry', 'Couldn’t load models. Try again')}
            onPress={props.onRetry}
            disabled={props.disabled}
            accessibilityRole="button"
          />
        </SettingsSection>
      ) : props.catalogState === 'loading' ? (
        <SettingsNote>
          {t('bots.settings.backupModelsCatalogLoading', 'Loading models…')}
        </SettingsNote>
      ) : grouped.length === 0 ? (
        <SettingsNote>
          {t('bots.settings.backupModelsNoOptions', 'No other models available on this computer.')}
        </SettingsNote>
      ) : (
        grouped.map(([agent, list]) => (
          <SettingsSection key={agent} title={botAgentLabel(agent)}>
            {list.map((option) => (
              <ListRow
                key={botModelTargetKey(option)}
                title={option.label}
                subtitle={
                  option.state === 'at-limit'
                    ? t('bots.settings.backupModelsAtLimit', 'At usage limit')
                    : option.state === 'unavailable'
                      ? t('bots.settings.backupModelsUnavailable', 'Unavailable')
                      : option.model
                }
                disabled={props.disabled}
                onPress={() => {
                  if (option.efforts?.length) {
                    setPendingOption(option)
                  } else {
                    props.onPick({
                      agent: option.agent,
                      ...(option.model ? { model: option.model } : {})
                    })
                  }
                }}
                accessibilityRole="button"
              />
            ))}
          </SettingsSection>
        ))
      )}
    </>
  )
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm
  }
})
