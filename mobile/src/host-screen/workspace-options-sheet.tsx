import { useMemo, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useBackClaim } from '../navigation/use-back-claim'
import { BottomDrawer } from '../components/BottomDrawer'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import {
  WORKSPACE_VIEW_SECTION_LABELS,
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionKey
} from '../../../src/shared/workspace-view/workspace-view-options'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'
import {
  WORKSPACE_OPTIONS_TITLE,
  WORKSPACE_VIEW_SHARED_NOTE
} from '../worktree/workspace-options-copy'
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { withServerHosts } from '../worktree/server-workspaces'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'
import { DrillRow, OptionRowList } from './workspace-option-rows'
import { OptionPager, useOptionPager, type OptionPagerControls } from './workspace-options-pager'
import {
  WORKSPACE_OPTION_CONTROLS,
  type WorkspaceOptionHost,
  type WorkspaceOptionProps
} from './workspace-option-controls'

/** Every host the list can show, this computer first; labelled as the rows label them. */
function useWorkspaceOptionHosts(controller: HostScreenController): WorkspaceOptionHost[] {
  const { displayWorktrees, state } = controller
  return useMemo(() => {
    const ids = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    state.repoHostIdByRepoId.forEach((id) => ids.add(id))
    state.serverWorkspaces.hosts.forEach((host) => ids.add(host.hostId))
    displayWorktrees.forEach((row) => ids.add(resolveWorktreeHostId(row, state.repoHostIdByRepoId)))
    const hostLabelById = withServerHosts(
      state.hostLabelById,
      state.serverWorkspaces.hosts,
      (host) => host.label
    )
    return [...ids].map((id) => ({
      id,
      label: getHostContextLabel(id, { hostLabelById, hostPlatform: state.hostPlatform })
    }))
  }, [
    displayWorktrees,
    state.repoHostIdByRepoId,
    state.serverWorkspaces.hosts,
    state.hostLabelById,
    state.hostPlatform
  ])
}

/** The desktop sidebar's Workspace options, rendered from the shared option list. */
export function WorkspaceOptionsSheet({ controller }: { controller: HostScreenController }) {
  const { state } = controller
  const pager = useOptionPager<WorkspaceViewOptionKey>()
  return (
    <BottomDrawer
      visible={state.showWorkspaceOptions}
      onClose={() => state.setShowWorkspaceOptions(false)}
      // The sheet opens on its main page next time.
      onAfterClose={pager.forget}
      // A page opens at the top even when the main sheet was scrolled down to its row.
      scrollResetKey={pager.page}
    >
      <WorkspaceOptionsContent controller={controller} pager={pager} />
    </BottomDrawer>
  )
}

// Its own component so the host list is built only while the sheet is open.
function WorkspaceOptionsContent({
  controller,
  pager
}: {
  controller: HostScreenController
  pager: OptionPagerControls<WorkspaceViewOptionKey>
}) {
  const { settings, state } = controller
  const hosts = useWorkspaceOptionHosts(controller)
  const sections = getShownWorkspaceViewSections({
    groupBy: state.view.groupBy,
    hideSleepingWorkspaces: state.view.filters.hideSleepingWorkspaces,
    hideWorkspacesFromOtherDevices: state.view.filters.hideWorkspacesFromOtherDevices,
    newCardStyle: state.view.newCardStyle,
    hasRemoteHosts: hosts.some((host) => parseExecutionHostId(host.id)?.kind !== 'local'),
    projectCount: controller.sectionsResult.uniqueRepos.length,
    // Why the host's say-so: a host that keeps the filter to itself cannot apply the phone's value.
    mayHaveServerHosts:
      state.view.sharesOtherClientFilter === true && state.serverWorkspaces.hosts.length > 0
  })

  // The open option; it falls back to the main sheet once the option stops showing.
  const pageOption = sections
    .flatMap(({ options }) => options)
    .find((option) => option.key === pager.page)
  const pageControl = pageOption ? WORKSPACE_OPTION_CONTROLS[pageOption.key] : null
  // Back from a page returns to the main sheet; the drawer's own claim closes it from there.
  useBackClaim(
    pageOption
      ? () => {
          pager.close()
          return true
        }
      : null
  )
  const page =
    pageOption && pageControl?.kind === 'page' ? (
      <>
        <Pressable
          style={styles.optionBack}
          onPress={pager.close}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${WORKSPACE_OPTIONS_TITLE}`}
        >
          <ChevronLeft size={16} color={colors.textSecondary} />
          <Text style={styles.optionBackText}>{WORKSPACE_OPTIONS_TITLE}</Text>
        </Pressable>
        <Text style={[styles.filterModalTitle, styles.optionPageTitle]}>{pageOption.label}</Text>
        <pageControl.Page controller={controller} hosts={hosts} label={pageOption.label} />
      </>
    ) : null

  const main = (
    <>
      <View style={styles.filterModalHeader}>
        <View style={styles.filterModalHeading}>
          <Text style={styles.filterModalTitle}>{WORKSPACE_OPTIONS_TITLE}</Text>
          <Text style={styles.filterModalSubtitle}>{WORKSPACE_VIEW_SHARED_NOTE}</Text>
        </View>
        {controller.activeFilterCount > 0 && (
          <Pressable onPress={settings.clearFilters}>
            <Text style={styles.clearFiltersText}>Clear filters</Text>
          </Pressable>
        )}
      </View>

      {sections.map(({ section, options }) => {
        const sectionLabel = WORKSPACE_VIEW_SECTION_LABELS[section]
        // Inline unframed rows sit above the section's card; every other row goes in the card.
        const bareRows: ReactNode[] = []
        const framedRows: ReactNode[] = []
        for (const option of options) {
          const control = WORKSPACE_OPTION_CONTROLS[option.key]
          const props: WorkspaceOptionProps = { controller, hosts, label: option.label }
          if (control.kind === 'page') {
            framedRows.push(
              <DrillRow
                key={option.key}
                label={option.label}
                value={control.value(props)}
                onPress={() => pager.open(option.key)}
              />
            )
          } else {
            const target = control.framed ? framedRows : bareRows
            target.push(<control.Row key={option.key} {...props} />)
          }
        }
        return (
          <View key={section} testID={`workspace-option-section-${section}`}>
            {sectionLabel && <Text style={styles.filterSectionLabel}>{sectionLabel}</Text>}
            {bareRows}
            {framedRows.length > 0 && (
              <View style={styles.filterGroup}>
                <OptionRowList>{framedRows}</OptionRowList>
              </View>
            )}
          </View>
        )
      })}
    </>
  )

  return <OptionPager pager={pager} main={main} page={page} />
}
