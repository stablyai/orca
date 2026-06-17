import { ScrollView, Text, View } from 'react-native'
import { FileWarning } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRInfo } from '../../../../src/shared/types'
import { PRSection } from './PRSection'
import { resolveConflictDisplay } from './pr-conflict-presentation'
import { prConflictStyles as styles } from './pr-conflict-styles'

type Props = {
  pr: PRInfo
  // True while a refresh is in flight, so the fallback notice can explain that
  // missing conflict file details may still be loading (desktop parity).
  isRefreshing?: boolean
}

// Conflicting-files section — shown only when the hosted review reports merge
// conflicts. Lists the conflicting file paths, or a fallback notice when the file
// list is not yet available. Ports the desktop ConflictingFilesSection +
// MergeConflictNotice into the mobile card shell.
export function PRConflictingFilesSection({ pr, isRefreshing = false }: Props) {
  const conflict = resolveConflictDisplay(pr)
  if (!conflict) {
    return null
  }

  return (
    <PRSection title="Conflicts">
      {conflict.commitsBehind !== null && conflict.baseCommit !== null ? (
        <Text style={styles.meta}>
          {conflict.commitsBehind} commit{conflict.commitsBehind === 1 ? '' : 's'} behind (base
          commit: <Text style={styles.metaMono}>{conflict.baseCommit}</Text>)
        </Text>
      ) : null}

      {conflict.fileDetailsUnavailable ? (
        <View>
          <Text style={styles.noticeTitle}>This branch has conflicts that must be resolved</Text>
          <Text style={styles.noticeBody}>
            {isRefreshing
              ? 'Refreshing conflict details…'
              : 'Conflict file details are unavailable'}
          </Text>
        </View>
      ) : (
        <View>
          <View style={styles.filesHeader}>
            <FileWarning size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.filesHeaderText}>Conflicting files</Text>
          </View>
          <ScrollView
            style={styles.fileList}
            contentContainerStyle={styles.fileListContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {conflict.files.map((filePath) => (
              <View key={filePath} style={styles.fileRow}>
                <Text style={styles.filePath}>{filePath}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </PRSection>
  )
}
