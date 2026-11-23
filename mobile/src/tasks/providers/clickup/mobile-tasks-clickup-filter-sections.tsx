import { View } from 'react-native'
import { ListGroup, ListRow, SectionHeader } from '../../../components/list/ListGroup'
import { translate as t } from '../../../i18n/mobile-i18n'
import { colors } from '../../../theme/mobile-theme'
import { styles } from '../../mobile-tasks-legacy-styles'
import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import {
  offeredClickUpStatuses,
  safeClickUpColor,
  toggleClickUpIncludeClosed,
  toggleClickUpStatus,
  withClickUpStatuses
} from './mobile-clickup-filters'

/** How many ClickUp filters differ from their defaults; the Filter chip adds it to its count. */
export function clickUpFilterCount(model: ConnectionPresentationModel): number {
  const { clickupFilter } = model
  return (clickupFilter.includeClosed ? 1 : 0) + ((clickupFilter.statuses?.length ?? 0) > 0 ? 1 : 0)
}

/** Closed tasks and the status filter, applied as they are tapped; the sheet stays open to change more. */
export function renderMobileTasksClickUpFilterSections(model: ConnectionPresentationModel) {
  const { clickupFilter, clickupKnownStatuses, setClickUpFilter } = model
  const statuses = offeredClickUpStatuses(clickupFilter, clickupKnownStatuses)
  const selected = clickupFilter.statuses ?? []
  return (
    <>
      <SectionHeader title={t('tasks.clickUp.closedSection', 'Closed tasks')} />
      <ListGroup>
        <ListRow
          key="include-closed"
          title={t('tasks.clickUp.includeClosed', 'Include closed')}
          subtitle={t('tasks.clickUp.includeClosedSubtitle', 'Also show done and closed tasks')}
          selected={clickupFilter.includeClosed}
          accessibilityRole="checkbox"
          onPress={() =>
            setClickUpFilter((current) => toggleClickUpIncludeClosed(current, clickupKnownStatuses))
          }
        />
      </ListGroup>
      {statuses.length > 0 ? (
        <>
          <SectionHeader title={t('tasks.clickUp.statusSection', 'Status')} />
          <ListGroup>
            <ListRow
              key="all-statuses"
              title={t('tasks.clickUp.allStatuses', 'All statuses')}
              leading={<View />}
              selected={selected.length === 0}
              accessibilityRole="checkbox"
              onPress={() => setClickUpFilter((current) => withClickUpStatuses(current, []))}
            />
            {statuses.map((status) => (
              <ListRow
                key={status.name}
                title={status.name}
                leading={
                  <View
                    style={[
                      styles.pickerRepoDot,
                      { backgroundColor: safeClickUpColor(status.color) ?? colors.textMuted }
                    ]}
                  />
                }
                selected={selected.includes(status.name)}
                accessibilityRole="checkbox"
                onPress={() =>
                  setClickUpFilter((current) => toggleClickUpStatus(current, status.name))
                }
              />
            ))}
          </ListGroup>
        </>
      ) : null}
    </>
  )
}
