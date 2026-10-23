import type { ReactNode } from 'react'
import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  BottomDrawer,
  View,
  Text,
  StyleSheet,
  TaskProviderLogo,
  RefreshCw,
  colors,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { taskKindLabel } from './mobile-tasks-legacy-foundation'
import type { TaskProvider } from './mobile-tasks-dependencies'
import { renderMobileTasksItemDetailContent } from './mobile-tasks-item-detail-content'
import { renderMobileTasksItemActions } from './mobile-tasks-item-actions'
import { MobileTasksSheetError } from './mobile-tasks-sheet-chrome'
import { IconButton } from '../components/ui/IconButton'

type DetailHeaderProps = {
  provider: TaskProvider
  kind: string
  title: string
  meta: string
  /** A trailing control on the kind line, e.g. Refresh. */
  trailing?: ReactNode
}

/** Provider mark and kind, the title at 22 pt, then one meta line. */
export function MobileTasksDetailHeader({
  provider,
  kind,
  title,
  meta,
  trailing
}: DetailHeaderProps) {
  return (
    <View style={detailHeaderStyles.root}>
      <View style={detailHeaderStyles.kindRow}>
        <TaskProviderLogo provider={provider} size={16} color={colors.textSecondary} />
        <Text style={detailHeaderStyles.kind} numberOfLines={1}>
          {kind}
        </Text>
        {trailing}
      </View>
      <Text style={detailHeaderStyles.title} numberOfLines={4} accessibilityRole="header">
        {title}
      </Text>
      {meta ? (
        <Text style={detailHeaderStyles.meta} numberOfLines={2}>
          {meta}
        </Text>
      ) : null}
    </View>
  )
}

export function renderMobileTasksItemDetailDrawer(model: PageChromeModel) {
  const {
    actionItem,
    detailLoading,
    error,
    setError,
    taskDetailHandoff,
    setDetailRefreshSeq,
    taskUiReady
  } = model
  return (
    <BottomDrawer visible={taskUiReady && actionItem != null} {...taskDetailHandoff.drawerProps}>
      {actionItem ? (
        <View>
          <MobileTasksDetailHeader
            provider={actionItem.provider}
            kind={taskKindLabel(actionItem)}
            title={actionItem.title}
            meta={`${actionItem.subtitle} · ${actionItem.status}`}
            trailing={
              <IconButton
                icon={RefreshCw}
                iconSize={16}
                variant="bare"
                iconColor={colors.textSecondary}
                accessibilityLabel="Refresh details"
                disabled={detailLoading}
                onPress={() => setDetailRefreshSeq((current) => current + 1)}
              />
            }
          />
          <MobileTasksSheetError error={error} onDismiss={() => setError('')} />
          {renderMobileTasksItemActions(model)}
          {renderMobileTasksItemDetailContent(model)}
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export const detailHeaderStyles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing.xs + 4,
    paddingBottom: spacing.lg,
    gap: spacing.xs
  },
  kindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44
  },
  kind: { ...textStyles.footnote, flex: 1, color: colors.textSecondary },
  title: { ...textStyles.title, color: colors.textPrimary },
  meta: { ...textStyles.subhead, color: colors.textSecondary }
})
