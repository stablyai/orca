import { SwitchRow } from './workspace-option-rows'
import type { WorkspaceOptionProps } from './workspace-option-controls'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

/** "Hide by status", then one switch per board status while it is on, as on the desktop. */
export function WorkspaceStatusFilterSwitches({ controller, label }: WorkspaceOptionProps) {
  const t = useMobileTranslation()
  const { filters, workspaceStatuses } = controller.state.view
  const hidden = filters.hiddenWorkspaceStatusIds
  return (
    <>
      <SwitchRow
        label={label}
        value={filters.hideWorkspacesByStatus}
        onChange={(next) => controller.settings.setFilter('hideWorkspacesByStatus', next)}
      />
      {filters.hideWorkspacesByStatus &&
        workspaceStatuses.map((status) => (
          <SwitchRow
            key={status.id}
            indent
            label={status.label}
            accessibilityLabel={t(
              'hostScreen.workspaceOptionsSheet.hideStatus',
              'Hide {{status}} workspaces',
              { status: status.label }
            )}
            value={hidden.includes(status.id)}
            onChange={(hide) =>
              controller.settings.setFilter(
                'hiddenWorkspaceStatusIds',
                hide ? [...hidden, status.id] : hidden.filter((id) => id !== status.id)
              )
            }
          />
        ))}
    </>
  )
}
