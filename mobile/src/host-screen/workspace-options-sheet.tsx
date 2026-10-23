import { useMemo, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'
import { IconButton } from '../components/ui/IconButton'
import { SectionHeader } from '../components/ui/SectionHeader'
import { SheetHeader } from '../components/ui/SheetHeader'
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
import type { HostScreenController } from './use-host-screen-controller'
import { DrillRow, OptionGroup } from './workspace-option-rows'
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
      label: getHostContextLabel(id, {
        hostLabelById,
        hostPlatform: state.hostPlatform
      })
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
      <WorkspaceOptionsContent
        controller={controller}
        pager={pager}
        onDone={() => state.setShowWorkspaceOptions(false)}
      />
    </BottomDrawer>
  )
}

/** The phone's own changes the desktop has not answered; a slow answer is not a refusal. */
function WorkspaceOptionsPending({ settings }: Pick<HostScreenController, 'settings'>) {
  const { pending, stale } = settings.pendingViewChanges
  if (!pending.some((change) => change.kind === 'view')) {
    return null
  }
  return (
    <View style={styles.optionPending} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text style={styles.pendingText}>
        {stale ? 'Still waiting for the desktop…' : 'Saving to the desktop…'}
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
        <View style={styles.pageHeader}>
          <View style={styles.pageHeaderSide}>
            <IconButton
              icon={ChevronLeft}
              iconSize={22}
              variant="bare"
              accessibilityLabel={`Back to ${WORKSPACE_OPTIONS_TITLE}`}
              onPress={pager.close}
            />
          </View>
          <Text style={styles.pageTitle} numberOfLines={1} accessibilityRole="header">
            {pageOption.label}
          </Text>
          <View style={[styles.pageHeaderSide, styles.pageHeaderTrailing]}>
            <SheetDoneAction onDone={onDone} />
          </View>
        </View>
        <pageControl.Page controller={controller} hosts={hosts} label={pageOption.label} />
      </>
    ) : null

  const main = (
    <>
      <SheetHeader
        title={WORKSPACE_OPTIONS_TITLE}
        subtitle={WORKSPACE_VIEW_SHARED_NOTE}
        leading={{
          label: 'Reset',
          onPress: settings.clearFilters,
          disabled: controller.activeFilterCount === 0
        }}
        trailing={{ label: 'Done', onPress: onDone }}
      />
      <WorkspaceOptionsPending settings={settings} />

      {sections.map(({ section, options }) => {
        const sectionLabel = WORKSPACE_VIEW_SECTION_LABELS[section]
        // Inline unframed rows sit above the section's card; every other row goes in the card.
        const bareRows: ReactNode[] = []
        const framedRows: ReactNode[] = []
        for (const option of options) {
          const control = WORKSPACE_OPTION_CONTROLS[option.key]
          const props: WorkspaceOptionProps = {
            controller,
            hosts,
            label: option.label
          }
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
            {sectionLabel ? <SectionHeader title={sectionLabel} /> : <View style={styles.gap} />}
            {bareRows}
            {framedRows.length > 0 && <OptionGroup>{framedRows}</OptionGroup>}
          </View>
        )
      })}
    </>
  )

  return <OptionPager pager={pager} main={main} page={page} />
}

/** `SheetHeader`'s Done, for a sub-page whose leading side is a back button it has no slot for. */
function SheetDoneAction({ onDone }: { onDone: () => void }) {
  return (
    <Pressable
      onPress={onDone}
      accessibilityRole="button"
      accessibilityLabel="Done"
      style={({ pressed }) => [styles.done, pressed && styles.donePressed]}
    >
      <Text style={styles.doneLabel}>Done</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  optionPending: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.xs
  },
  pendingText: { ...textStyles.footnote, color: colors.textMuted },
  gap: { height: spacing.lg },
  pageHeader: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm
  },
  pageHeaderSide: { width: 84, flexDirection: 'row', alignItems: 'center' },
  pageHeaderTrailing: { justifyContent: 'flex-end' },
  pageTitle: {
    ...textStyles.headline,
    flex: 1,
    color: colors.textPrimary,
    textAlign: 'center'
  },
  done: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    justifyContent: 'center'
  },
  donePressed: { backgroundColor: colors.fill },
  doneLabel: { ...textStyles.headline, color: colors.textPrimary }
})
