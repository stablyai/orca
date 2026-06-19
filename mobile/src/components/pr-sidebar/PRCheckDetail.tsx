import { ActivityIndicator, ScrollView, Text, View } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRCheckRunDetails } from '../../../../src/shared/types'
import { presentCheckDetail, type CheckDetailJob } from './pr-check-detail-content'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

// Per-check lazily-fetched detail. `loading`/`error` track the in-flight fetch;
// `details` (once set) is the cache so collapse/re-expand never re-fetches.
export type DetailEntry =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; details: PRCheckRunDetails | null }

// Renders the expanded detail for one check: conclusion/title/summary, plus the
// annotations and failed-job/step summary from the github.prCheckDetails payload
// (parity with the desktop ChecksPanel detail). Muted/monochrome and scrollable
// so long CI output never breaks the sidebar layout.
export function PRCheckDetailView({ entry }: { entry: DetailEntry | undefined }) {
  if (!entry || entry.status === 'loading') {
    return (
      <View style={styles.checkDetailArea}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (entry.status === 'error') {
    return (
      <View style={styles.checkDetailArea}>
        <Text style={styles.checkDetailText}>{entry.message}</Text>
      </View>
    )
  }
  if (!entry.details) {
    return (
      <View style={styles.checkDetailArea}>
        <Text style={styles.checkDetailText}>No details available.</Text>
      </View>
    )
  }

  const content = presentCheckDetail(entry.details)
  const isEmpty =
    content.summaryLines.length === 0 &&
    content.annotations.length === 0 &&
    content.jobs.length === 0

  return (
    <View style={styles.checkDetailArea}>
      {isEmpty ? (
        <Text style={styles.checkDetailText}>No details available.</Text>
      ) : (
        <>
          {content.summaryLines.map((line, index) => (
            <Text key={index} style={styles.checkDetailText}>
              {line}
            </Text>
          ))}
          {content.annotations.length > 0 ? (
            <View style={styles.checkDetailGroup}>
              <Text style={styles.checkDetailGroupLabel}>Annotations</Text>
              {content.annotations.map((annotation, index) => (
                <View key={index}>
                  <Text style={styles.checkDetailLocator} numberOfLines={1}>
                    {annotation.locator}
                    {annotation.level ? ` · ${annotation.level}` : ''}
                  </Text>
                  {annotation.title ? (
                    <Text style={styles.checkDetailEmphasis}>{annotation.title}</Text>
                  ) : null}
                  <Text style={styles.checkDetailText}>{annotation.message}</Text>
                </View>
              ))}
              {content.annotationsTruncated ? (
                <Text style={styles.checkDetailText}>Showing first 20 annotations</Text>
              ) : null}
            </View>
          ) : null}
          {content.jobs.length > 0 ? (
            <View style={styles.checkDetailGroup}>
              <Text style={styles.checkDetailGroupLabel}>{content.jobsLabel}</Text>
              {content.jobs.map((job, index) => (
                <JobRow key={index} job={job} />
              ))}
              {content.jobsTruncated ? (
                <Text style={styles.checkDetailText}>Showing first 100 jobs</Text>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  )
}

function JobRow({ job }: { job: CheckDetailJob }) {
  return (
    <View>
      <View style={styles.checkDetailStepRow}>
        <Text style={styles.checkDetailEmphasis} numberOfLines={1}>
          {job.name}
        </Text>
        <Text style={styles.checkDetailText}>{job.state}</Text>
      </View>
      {job.failedSteps.map((step, index) => (
        <View key={index} style={styles.checkDetailStepRow}>
          <Text style={styles.checkDetailText} numberOfLines={1}>
            {step.name}
          </Text>
          <Text style={styles.checkDetailText}>{step.state}</Text>
        </View>
      ))}
      {job.logTail ? (
        <ScrollView style={styles.checkDetailLogScroll} nestedScrollEnabled>
          <Text style={styles.checkDetailLogText}>{job.logTail}</Text>
        </ScrollView>
      ) : null}
    </View>
  )
}
