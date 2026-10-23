import { ScrollView, Text, View } from 'react-native'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import { triggerSelection } from '../platform/haptics'
import { MobileSegmentedControl, type MobileSegment } from './MobileSegmentedControl'
import { MobileSwitch } from './MobileSwitch'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'
import { Badge } from './ui/Badge'
import { Banner } from './ui/Banner'
import { ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'

type SetupDecision = Exclude<WorkspaceCreateSetupDecision, 'inherit'>

const DECISIONS: readonly MobileSegment<SetupDecision>[] = [
  { value: 'run', label: 'Run' },
  { value: 'skip', label: 'Skip' }
]

/**
 * The repo's setup script and whether it runs. Under the "ask" policy the choice blocks Create, so
 * the form shows this outside Options with a banner until it is made.
 */
export function NewWorkspaceSetupScriptField({
  command,
  source,
  runPolicy,
  decision,
  runSetup,
  onDecisionChange,
  onRunSetupChange
}: {
  command: string
  source: string | null
  runPolicy: SetupRunPolicy
  decision: SetupDecision | null
  runSetup: boolean
  onDecisionChange: (decision: SetupDecision) => void
  onRunSetupChange: (run: boolean) => void
}) {
  const asks = runPolicy === 'ask'
  return (
    <>
      <View style={styles.bleed}>
        <SectionHeader
          title="Setup script"
          action={source ? <Badge label={source === 'orca.yaml' ? 'orca.yaml' : 'Hooks'} /> : null}
        />
      </View>
      {asks && decision === null ? (
        <View style={[styles.bleed, styles.bannerAfter]}>
          <Banner
            tone="warning"
            message="Choose whether to run this repository's setup script before creating."
          />
        </View>
      ) : null}
      <View style={styles.setupBlock}>
        {asks ? (
          <MobileSegmentedControl
            segments={DECISIONS}
            selected={decision ?? undefined}
            onSelect={onDecisionChange}
            fill
          />
        ) : (
          <ListGroup style={styles.flush}>
            <ListRow
              title="Run setup script"
              accessory={
                <MobileSwitch
                  value={runSetup}
                  onValueChange={(value) => {
                    triggerSelection()
                    onRunSetupChange(value)
                  }}
                  accessibilityLabel="Run setup script"
                />
              }
            />
          </ListGroup>
        )}
        <ScrollView
          style={styles.codeBlock}
          contentContainerStyle={styles.codeContent}
          nestedScrollEnabled
        >
          <Text style={styles.code} selectable>
            {command}
          </Text>
        </ScrollView>
      </View>
    </>
  )
}
