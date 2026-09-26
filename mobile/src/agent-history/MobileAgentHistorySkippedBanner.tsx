import { Text, View } from 'react-native'
import {
  isSkippedAiVaultTranscriptIssue,
  type AiVaultScanIssue
} from '../../../src/shared/ai-vault-types'
import { styles } from './agent-history-styles'

/**
 * How many transcripts the scan could not read.
 *
 * Why the filter: the scan also reports commentary about itself — an unreachable
 * host, a bounded scope, a note about one session it did list. Counting those
 * here is what left a permanent "1 transcript skipped" over a session the scan
 * had read fine, because the parse cache replays that note on every rescan.
 */
export function MobileAgentHistorySkippedBanner({
  issues
}: {
  issues: readonly AiVaultScanIssue[]
}) {
  const skipped = issues.filter(isSkippedAiVaultTranscriptIssue).length
  if (skipped === 0) {
    return null
  }
  return (
    <View style={styles.noticeBanner}>
      <Text style={styles.noticeText}>
        {skipped} {skipped === 1 ? 'transcript' : 'transcripts'} skipped
      </Text>
    </View>
  )
}
