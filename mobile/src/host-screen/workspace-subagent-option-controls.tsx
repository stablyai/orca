import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { DEFAULT_SUBAGENT_DISPLAY_MODE } from '../../../src/shared/constants'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'
import { subagentDisplayChoices } from './workspace-option-controls-copy'
import { SwitchRow } from './workspace-option-rows'

export function SubagentOptionControls({ controller }: { controller: HostScreenController }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const showSubagents = controller.state.view.showSubagents !== false
  const subagentDisplayMode =
    controller.state.view.subagentDisplayMode ?? DEFAULT_SUBAGENT_DISPLAY_MODE
  return (
    <>
      <SectionHeader
        title={t('hostScreen.workspaceOptionControls.subagentsSection', 'Subagents')}
      />
      <ListGroup style={styles.optionGroup}>
        <SwitchRow
          label={t('hostScreen.workspaceOptionControls.showSubagents', 'Show subagents')}
          value={showSubagents}
          onChange={controller.settings.setShowSubagents}
        />
      </ListGroup>
      {showSubagents && (
        <>
          <SectionHeader
            title={t('hostScreen.workspaceOptionControls.subagentDisplay', 'Subagent display')}
          />
          <MobileSegmentedControl
            segments={subagentDisplayChoices(t).map(({ id, label }) => ({
              value: id,
              label
            }))}
            selected={subagentDisplayMode}
            onSelect={controller.settings.setSubagentDisplayMode}
            fill
            onSheet
            style={styles.optionSegmented}
          />
        </>
      )}
    </>
  )
}
