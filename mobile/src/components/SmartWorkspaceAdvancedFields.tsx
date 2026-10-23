import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { triggerSelection } from '../platform/haptics'
import { MobileSwitch } from './MobileSwitch'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import { ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { TextField } from './ui/TextField'

type Props = {
  composer: MobileComposerSource
  selectedRepoIsGit: boolean
}

// The Options-group source controls: the editable Name appears once a source
// row is shown (the field itself is no longer the name input); the branch-name
// override and reuse toggle mirror the desktop composer's advanced branch fields.
export function SmartWorkspaceAdvancedFields({ composer, selectedRepoIsGit }: Props) {
  const selection = composer.smartNameSelection
  const showBranchOverride = selectedRepoIsGit && (!selection || selection.kind === 'branch')
  const reuseLabel = composer.reuseEligibleBranch
    ? `Reuse branch “${composer.reuseEligibleBranch}”`
    : null
  return (
    <>
      {selection ? (
        <TextField
          label="Name"
          value={composer.name}
          onChangeText={composer.setName}
          placeholder="Workspace name"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      {showBranchOverride ? (
        <TextField
          label="Branch name"
          value={composer.branchNameOverride ?? ''}
          onChangeText={composer.handleBranchNameOverrideChange}
          placeholder="Derived from name"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      {reuseLabel ? (
        <ListGroup style={styles.flush}>
          <ListRow
            title={reuseLabel}
            accessory={
              <MobileSwitch
                value={composer.reuseSelectedBranch}
                onValueChange={(value) => {
                  triggerSelection()
                  composer.setReuseSelectedBranch(value)
                }}
                accessibilityLabel={reuseLabel}
              />
            }
          />
        </ListGroup>
      ) : null}
    </>
  )
}
