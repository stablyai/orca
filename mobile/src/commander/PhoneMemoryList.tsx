import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import type { ReactNode } from 'react'
import { colors } from '../theme/mobile-theme'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MemoryButton, s } from './phone-memory-controls'
import type { PhonePages, PhonePageSummary } from './phone-memory-rpc'

export function PhoneMemoryList({
  collection,
  filtered,
  search,
  setting,
  handoffs,
  busy,
  includeDeleted,
  problem,
  allProjects,
  labels,
  newPage,
  newRule,
  refresh,
  toggleDeleted,
  more,
  open
}: {
  setting: ReactNode
  filtered: boolean
  search: ReactNode
  collection: PhonePages | null
  handoffs: boolean
  busy: boolean
  includeDeleted: boolean
  problem: ReactNode
  allProjects: string
  labels: Record<PhonePageSummary['kind'], string>
  newPage: () => void
  newRule: () => void
  refresh: () => void
  toggleDeleted: () => void
  more: () => void
  open: (id: string) => void
}) {
  const t = useMobileTranslation()
  return (
    <FlatList
      data={collection?.pages ?? []}
      contentContainerStyle={s.stack}
      keyExtractor={(p) => p.pageId}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <>
          {search}
          {setting}
          <View style={s.row}>
            <MemoryButton
              label={
                handoffs
                  ? t('commander.handoffNew', 'New handoff')
                  : t('commander.memoryNew', 'New page')
              }
              primary
              disabled={busy || !collection}
              onPress={newPage}
            />
            {!handoffs && (
              <MemoryButton
                label={t('commander.ruleNew', 'New recurring answer')}
                disabled={busy || !collection?.projects.length}
                onPress={newRule}
              />
            )}
            <MemoryButton
              label={t('common.refresh', 'Refresh')}
              disabled={busy}
              onPress={refresh}
            />
            {!handoffs && (
              <MemoryButton
                label={t('commander.memoryShowDeleted', 'Include deleted')}
                selected={includeDeleted}
                disabled={busy}
                onPress={toggleDeleted}
              />
            )}
            {!handoffs && collection?.projects.length === 0 && (
              <Text style={s.meta}>
                {t(
                  'commander.ruleNoProjects',
                  'Add a project on the paired desktop to create a recurring answer.'
                )}
              </Text>
            )}
          </View>
        </>
      }
      ListEmptyComponent={
        busy ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : collection && !problem ? (
          <Text style={s.meta}>
            {filtered
              ? t('commander.handoffNoMatches', 'No matching handoffs.')
              : handoffs
                ? t(
                    'commander.handoffEmpty',
                    'Save a goal to your account to continue it on another host.'
                  )
                : t('commander.memoryEmpty', 'No pages yet. Add a guideline, decision, or note.')}
          </Text>
        ) : undefined
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          style={s.item}
          disabled={busy}
          onPress={() => open(item.pageId)}
        >
          <Text style={s.title}>{item.recurringQuestion ?? item.title}</Text>
          <Text style={s.meta}>
            {item.deleted ? t('commander.memoryDeleted', 'Deleted') + ' · ' : ''}
            {item.recurringQuestion
              ? t('commander.ruleTitle', 'Recurring answer')
              : labels[item.kind]}{' '}
            · {item.projectId ?? allProjects}
            {handoffs && ' · ' + new Date(item.createdAt).toLocaleString(getUiIntlLocale())}
          </Text>
        </Pressable>
      )}
      ListFooterComponent={
        <View>
          {problem}
          {collection?.next && (
            <MemoryButton
              disabled={busy}
              label={t('commander.memoryMore', 'Load more')}
              onPress={more}
            />
          )}
        </View>
      }
    />
  )
}
