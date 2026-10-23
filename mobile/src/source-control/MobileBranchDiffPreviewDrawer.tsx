import { Text, View } from 'react-native'
import { FileWarning } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileDiffCodeLine } from '../components/MobileDiffCodeLine'
import { SheetHeader } from '../components/ui/SheetHeader'
import { StateView } from '../components/ui/StateView'
import { splitMobileFilePath } from './mobile-file-path-parts'
import type { MobileBranchDiffPreviewState } from './mobile-source-control-screen-state'
import { styles } from './mobile-source-control-styles'

type Props = {
  branchDiffPreview: MobileBranchDiffPreviewState | null
  onClose: () => void
}

export function MobileBranchDiffPreviewDrawer({ branchDiffPreview, onClose }: Props) {
  if (!branchDiffPreview) {
    return null
  }
  const entry = branchDiffPreview.entry
  const { name, directory } = splitMobileFilePath(entry.path)
  const range =
    branchDiffPreview.kind === 'ready'
      ? `${branchDiffPreview.summary.baseRef}..HEAD`
      : 'Committed on branch'
  return (
    <BottomDrawer
      visible={branchDiffPreview !== null}
      onClose={onClose}
      dragContentToDismiss={false}
      zIndex={1100}
    >
      <SheetHeader
        title={name}
        subtitle={directory ? `${directory} · ${range}` : range}
        onClose={onClose}
      />
      {branchDiffPreview.kind === 'loading' ? (
        <View style={styles.diffState}>
          <StateView loading title="Loading diff…" />
        </View>
      ) : branchDiffPreview.kind === 'error' ? (
        <View style={styles.diffState}>
          <StateView
            icon={FileWarning}
            title="Couldn’t load the diff"
            message={branchDiffPreview.message}
          />
        </View>
      ) : (
        <View style={styles.diffLines}>
          {branchDiffPreview.lines.map((line, index) => (
            <MobileDiffCodeLine
              key={`${index}:${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}`}
              line={line}
              selectable
            />
          ))}
          {branchDiffPreview.truncated ? (
            <Text style={styles.diffTruncatedText}>
              The diff is cut short on mobile. Open it on desktop to see the rest.
            </Text>
          ) : null}
        </View>
      )}
    </BottomDrawer>
  )
}
