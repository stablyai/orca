import { Text, View } from 'react-native'
import type { AiVaultScanIssue, AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  aiVaultScanNoticeIssues,
  skippedAiVaultTranscriptCount,
  skippedAiVaultTranscriptReasons
} from '../../../src/shared/ai-vault-scan-issue-state'
import { styles } from './agent-history-styles'

export function MobileAgentHistoryScanBanners({
  sessions,
  issues
}: {
  sessions: readonly AiVaultSession[]
  issues: readonly AiVaultScanIssue[]
}) {
  const scanResult = { sessions, issues }
  const noticeIssues = aiVaultScanNoticeIssues(scanResult)
  const skippedTranscriptCount = skippedAiVaultTranscriptCount(scanResult)
  const skippedTranscriptReasons = skippedAiVaultTranscriptReasons(scanResult)
  if (noticeIssues.length === 0 && skippedTranscriptCount === 0) {
    return null
  }

  return (
    <>
      {noticeIssues.map((issue) => (
        <View
          key={`${issue.executionHostId ?? 'local'}:${issue.kind}:${issue.agent}:${issue.path}:${issue.message}`}
          style={styles.noticeBanner}
        >
          <Text style={styles.noticeText}>{issue.message}</Text>
        </View>
      ))}
      {skippedTranscriptCount > 0 ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>
            {skippedTranscriptCount} {skippedTranscriptCount === 1 ? 'transcript' : 'transcripts'}{' '}
            skipped
          </Text>
        </View>
      ) : null}
      {skippedTranscriptReasons.map((reason) => (
        <View key={reason} style={styles.noticeBanner}>
          <Text style={styles.noticeText}>{reason}</Text>
        </View>
      ))}
    </>
  )
}
