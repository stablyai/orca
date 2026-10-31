import { useMemo, type ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useBackClaim } from '../navigation/use-back-claim'
import { BottomDrawer } from '../components/BottomDrawer'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import {
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionKey,
  type WorkspaceViewSection
} from '../../../src/shared/workspace-view/workspace-view-options'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { withServerHosts } from '../worktree/server-workspaces'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'
import { ListGroup } from '../components/list/ListGroup'
import { SectionHeader } from '../components/list/SectionHeader'
import { DrillRow } from './workspace-option-rows'
import { OptionPager, useOptionPager, type OptionPagerControls } from './workspace-options-pager'
import {
  WORKSPACE_OPTION_CONTROLS,
  type WorkspaceOptionHost,
  type WorkspaceOptionProps
} from './workspace-option-controls'

function workspaceOptionLabels(t: Translate): Record<WorkspaceViewOptionKey, string> {
  return {
    hosts: t('hostScreen.workspaceOptionsSheet.hosts', 'Hosts'),
    projects: t('hostScreen.workspaceOptionsSheet.projects', 'Projects'),
    groupBy: t('hostScreen.workspaceOptionsSheet.groupBy', 'Group by'),
    sortBy: t('hostScreen.workspaceOptionsSheet.sortBy', 'Sort by'),
    projectOrderBy: t('hostScreen.workspaceOptionsSheet.projectOrder', 'Project order'),
    cardLayout: t('hostScreen.workspaceOptionsSheet.cardLayout', 'Card layout'),
    cardProperties: t('hostScreen.workspaceOptionsSheet.showProperties', 'Show properties'),
    cardDisplay: t('hostScreen.workspaceOptionsSheet.cardDisplay', 'Card display'),
    hideSleepingWorkspaces: t('hostScreen.workspaceOptionsSheet.hideSleeping', 'Hide sleeping'),
    alwaysShowDefaultBranchWorkspace: t(
      'hostScreen.workspaceOptionsSheet.exceptDefaultBranch',
      'Except default branch'
    ),
    hideDefaultBranchWorkspace: t(
      'hostScreen.workspaceOptionsSheet.hideDefaultBranch',
      'Hide default branch'
    ),
    hideAutomationGeneratedWorkspaces: t(
      'hostScreen.workspaceOptionsSheet.hideAutomationCreated',
      'Hide automation-created'
    ),
    hideCliCreatedWorkspaces: t(
      'hostScreen.workspaceOptionsSheet.hideCliCreated',
      'Hide CLI-created'
    ),
    hideWorkspacesFromOtherDevices: t(
      'hostScreen.workspaceOptionsSheet.hideOtherClientWorkspaces',
      'Hide other-client workspaces'
    ),
    hideDetachedHeadWorkspaces: t(
      'hostScreen.workspaceOptionsSheet.hideDetachedHead',
      'Hide detached HEAD'
    )
  }
}

function workspaceSectionLabels(t: Translate): Record<WorkspaceViewSection, string | null> {
  return {
    show: t('hostScreen.workspaceOptionsSheet.show', 'Show'),
    group: t('hostScreen.workspaceOptionsSheet.groupBy', 'Group by'),
    arrange: null,
    filters: t('hostScreen.workspaceOptionsSheet.filters', 'Filters')
  }
}

function useWorkspaceOptionHosts(controller: HostScreenController): WorkspaceOptionHost[] {
  const t = useMobileTranslation()
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
    return [...ids].map((id) => {
      let label = getHostContextLabel(id, { hostLabelById, hostPlatform: state.hostPlatform })
      if (!hostLabelById.get(id)?.trim() && parseExecutionHostId(id)?.kind === 'local') {
        label =
          state.hostPlatform === 'darwin'
            ? t('hostScreen.workspaceOptionsSheet.localMac', 'Local Mac')
            : state.hostPlatform === 'win32'
              ? t('hostScreen.workspaceOptionsSheet.localWindows', 'Local Windows')
              : state.hostPlatform === 'linux'
                ? t('hostScreen.workspaceOptionsSheet.localLinux', 'Local Linux')
                : t('hostScreen.workspaceOptionsSheet.thisComputer', 'This computer')
      }
      return { id, label }
    })
  }, [
    displayWorktrees,
    state.repoHostIdByRepoId,
    state.serverWorkspaces.hosts,
    state.hostLabelById,
    state.hostPlatform,
    t
  ])
}

export function WorkspaceOptionsSheet({ controller }: { controller: HostScreenController }) {
  const { state } = controller
  const pager = useOptionPager<WorkspaceViewOptionKey>()
  return (
    <BottomDrawer
      visible={state.showWorkspaceOptions}
      onClose={() => state.setShowWorkspaceOptions(false)}
      onAfterClose={pager.forget}
      scrollResetKey={pager.page}
    >
      <WorkspaceOptionsContent
        controller={controller}
        pager={pager}
        onDone={() => state.setShowWorkspaceOptions(false)}
      />
    </BottomDrawer>
  )
}

function WorkspaceOptionsPending({ settings }: Pick<HostScreenController, 'settings'>) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { pending, stale } = settings.pendingViewChanges
  if (!pending.some((change) => change.kind === 'view')) {
    return null
  }
  return (
    <View style={styles.optionPending} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text style={styles.filterModalSubtitle}>
        {stale
          ? t('hostScreen.workspaceOptionsSheet.waitingForDesktop', 'Still waiting for the desktop')
          : t('hostScreen.workspaceOptionsSheet.savingToDesktop', 'Saving to the desktop')}
      </Text>
    </View>
  )
}

// Its own component so the host list is built only while the sheet is open.
function WorkspaceOptionsContent({
  controller,
  pager,
  onDone
}: {
  controller: HostScreenController
  pager: OptionPagerControls<WorkspaceViewOptionKey>
  onDone: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { settings, state } = controller
  const hosts = useWorkspaceOptionHosts(controller)
  const optionLabels = workspaceOptionLabels(t)
  const sectionLabels = workspaceSectionLabels(t)
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
  }).map(({ section, options }) => ({
    section,
    options: options.map((option) => ({ ...option, label: optionLabels[option.key] }))
  }))

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
  const title = t('hostScreen.workspaceOptionsSheet.workspaceOptions', 'Workspace options')
  const done = { label: t('hostScreen.workspaceOptionsSheet.done', 'Done'), onPress: onDone }
  const page =
    pageOption && pageControl?.kind === 'page' ? (
      <>
        <View>
          <SheetHeader title={pageOption.label} trailing={done} />
          <View style={styles.optionPageBack}>
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t(
                'hostScreen.workspaceOptionsSheet.backToOptions',
                'Back to Workspace options'
              )}
              onPress={pager.close}
            />
          </View>
        </View>
        <pageControl.Page controller={controller} hosts={hosts} label={pageOption.label} />
      </>
    ) : null

  const main = (
    <>
      <SheetHeader
        title={title}
        subtitle={t(
          'hostScreen.workspaceOptionsSheet.syncedAcrossDevices',
          'Synced across your devices'
        )}
        leading={{
          label: t('hostScreen.workspaceOptionsSheet.reset', 'Reset'),
          onPress: settings.clearFilters,
          disabled: controller.activeFilterCount === 0
        }}
        trailing={done}
      />
      <WorkspaceOptionsPending settings={settings} />

      {sections.map(({ section, options }, index) => {
        const sectionLabel = sectionLabels[section]
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
                value={control.value(props, t)}
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
            {sectionLabel ? (
              <SectionHeader title={sectionLabel} first={index === 0} />
            ) : (
              <View style={styles.optionSectionGap} />
            )}
            {bareRows}
            {framedRows.length > 0 && (
              <ListGroup style={styles.optionGroup}>{framedRows}</ListGroup>
            )}
          </View>
        )
      })}
    </>
  )

  return <OptionPager pager={pager} main={main} page={page} />
}
