import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  BottomDrawer,
  OptionPager,
  useOptionPager,
  type OptionPagerControls
} from '../../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerModalHostBackClaim } from '../../components/bottom-drawer/bottom-drawer-modal-host-scope'
import { useBackClaim } from '../../navigation/use-back-claim'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { githubKindOptions } from '../task-list/mobile-tasks-options'
import {
  mobileTasksFilterCount,
  resetMobileTasksFilters,
  selectMobileTasksGitHubKind,
  selectMobileTasksProvider
} from './mobile-tasks-filter-selection'
import { MobileTasksFilterPage, type MobileTasksFilterPageKey } from './mobile-tasks-filter-pages'
import {
  ChoiceSection,
  GitHubItemsSections,
  GitHubProjectSections,
  GitLabSections,
  JiraSections,
  LinearSections
} from './mobile-tasks-filter-sections'

function FilterSheetContent({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const styles = useThemedStyles(stylesSheet)
  const tr = useMobileTranslation()
  const { provider, providerOptions, githubMode, setShowFilterSheet } = model
  const done = {
    label: tr('tasks.filterSheet.done', 'Done'),
    onPress: () => setShowFilterSheet(false)
  }
  const connected =
    !(provider === 'linear' && !model.linearConnected) &&
    !(provider === 'jira' && !model.jiraConnection.connected)
  const page = pager.page ? (
    <MobileTasksFilterPage model={model} page={pager.page} onBack={pager.close} done={done} />
  ) : null
  const main = (
    <>
      <SheetHeader
        title={tr('tasks.filterSheet.title', 'Filter')}
        leading={{
          label: tr('tasks.filterSheet.reset', 'Reset'),
          onPress: () => resetMobileTasksFilters(model),
          disabled: mobileTasksFilterCount(model) === 0
        }}
        trailing={done}
      />
      {providerOptions.length > 1 ? (
        <MobileSegmentedControl
          segments={providerOptions}
          selected={provider}
          onSelect={(next) => {
            if (next !== provider) {
              selectMobileTasksProvider(model, next)
            }
          }}
          fill
          onSheet
          testIDPrefix="mobile-tasks-provider-"
          style={styles.segmented}
        />
      ) : null}
      {provider === 'github' ? (
        <ChoiceSection
          title={tr('tasks.filterSheet.show', 'Show')}
          options={githubKindOptions(tr)}
          selected={githubMode === 'project' ? 'project' : model.githubKind}
          onSelect={(kind) => selectMobileTasksGitHubKind(model, kind)}
        />
      ) : null}
      {!connected ? null : provider === 'github' && githubMode === 'project' ? (
        <GitHubProjectSections model={model} pager={pager} />
      ) : provider === 'github' ? (
        <GitHubItemsSections model={model} pager={pager} />
      ) : provider === 'gitlab' ? (
        <GitLabSections model={model} pager={pager} />
      ) : provider === 'linear' ? (
        <LinearSections model={model} pager={pager} />
      ) : (
        <JiraSections model={model} pager={pager} />
      )}
    </>
  )
  return <OptionPager pager={pager} main={main} page={page} />
}

/** Source, what to show, scope and sort in one sheet; pickers push inside it instead of replacing it. */
export function MobileTasksFilterSheet({ model }: { model: ConnectionPresentationModel }) {
  const pager = useOptionPager<MobileTasksFilterPageKey>()
  const back = pager.page
    ? () => {
        pager.close()
        return true
      }
    : null
  // Back from a page returns to the main sheet; the drawer's own claim closes it from there.
  useBottomDrawerModalHostBackClaim(back)
  useBackClaim(back)
  return (
    <BottomDrawer
      visible={model.taskUiReady && model.showFilterSheet}
      onClose={() => model.setShowFilterSheet(false)}
      onAfterClose={pager.forget}
      scrollResetKey={pager.page}
    >
      <FilterSheetContent model={model} pager={pager} />
    </BottomDrawer>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  segmented: { marginBottom: spacing.xs }
}))
