import { StyleSheet, View } from 'react-native'
import { SquareTerminal } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { StateView } from './ui/StateView'

// Empty detail pane shown beside the worktree-list sidebar on wide
// tablet/foldable layouts until the user opens a workspace.
export function WorkspaceDetailPlaceholder() {
  return (
    <View style={styles.container}>
      <StateView
        icon={SquareTerminal}
        title="No workspace open"
        message="Open a workspace from the sidebar to see its session here."
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
