import { Text, View } from 'react-native'
import type { AiVaultScanIssue, AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptCount,
  skippedAiVaultTranscriptReasons
} from '../../../src/shared/ai-vault-scan-issue-state'
import { styles } from './agent-history-styles'

export function MobileAgentHistoryScanBanners({
  sessions,
  issues
}: {
  sessions: readonly Pick<AiVaultSession, 'id'>[]
  issues: readonly AiVaultScanIssue[]
}) {
  const scanResult = { sessions, issues }
  const blocking = blockingAiVaultScanIssue(scanResult)
  const notices = aiVaultScanNoticeIssues(scanResult)
  const skipped = skippedAiVaultTranscriptCount(scanResult)

  return (
    <>
      {blocking ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.hostIssueText}>{blocking.message}</Text>
        </View>
      ) : null}
      {notices.map((issue) => (
        <View
          key={`${issue.executionHostId ?? 'local'}:${issue.kind}:${issue.agent}:${issue.path}:${issue.message}`}
          style={styles.noticeBanner}
        >
          <Text style={issue.kind === 'host' ? styles.hostIssueText : styles.noticeText}>
            {issue.message}
          </Text>
        </View>
      ))}
      {skipped > 0 ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>
            {skipped} {skipped === 1 ? 'transcript' : 'transcripts'} skipped
          </Text>
        </View>
      ) : null}
      {skippedAiVaultTranscriptReasons(scanResult).map((reason) => (
        <View key={reason} style={styles.noticeBanner}>
          <Text style={styles.noticeText}>{reason}</Text>
        </View>
      ))}
    </>
  )
}
