import { app } from 'electron'
import {
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData,
  type CrashReportDetailValue
} from '../../shared/crash-reporting'

type ProcessMetricLike = {
  pid?: unknown
  type?: unknown
  memory?: {
    workingSetSize?: unknown
  } | null
}
type CrashReportDetails = Record<string, CrashReportDetailValue>

type ProcessMetricBucket = {
  count: number
  workingSetMB: number
}

const PROCESS_METRIC_BUCKETS = ['browser', 'renderer', 'gpu', 'utility', 'other'] as const

type ProcessMetricBucketName = (typeof PROCESS_METRIC_BUCKETS)[number]

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function metricTypeBucket(type: unknown): ProcessMetricBucketName {
  const normalized = safeString(type)?.toLowerCase()
  if (normalized === 'browser') {
    return 'browser'
  }
  if (normalized === 'renderer' || normalized === 'tab') {
    return 'renderer'
  }
  if (normalized === 'gpu') {
    return 'gpu'
  }
  if (normalized === 'utility') {
    return 'utility'
  }
  return 'other'
}

function workingSetMB(metric: ProcessMetricLike): number {
  const workingSetKB = safeFiniteNumber(metric.memory?.workingSetSize) ?? 0
  return Math.round(Math.max(0, workingSetKB) / 1024)
}

function emptyBuckets(): Record<ProcessMetricBucketName, ProcessMetricBucket> {
  return {
    browser: { count: 0, workingSetMB: 0 },
    renderer: { count: 0, workingSetMB: 0 },
    gpu: { count: 0, workingSetMB: 0 },
    utility: { count: 0, workingSetMB: 0 },
    other: { count: 0, workingSetMB: 0 }
  }
}

function titleCaseBucket(bucket: ProcessMetricBucketName): string {
  return `${bucket[0].toUpperCase()}${bucket.slice(1)}`
}

export function collectProcessGoneMetricDetails(metrics: ProcessMetricLike[]): CrashReportDetails {
  const buckets = emptyBuckets()
  let largest: { pid: number; type: string; workingSetMB: number } | null = null

  for (const metric of metrics) {
    const bucket = buckets[metricTypeBucket(metric.type)]
    const metricWorkingSetMB = workingSetMB(metric)
    bucket.count += 1
    bucket.workingSetMB += metricWorkingSetMB
    const pid = safeFiniteNumber(metric.pid) ?? 0
    if (!largest || metricWorkingSetMB > largest.workingSetMB) {
      largest = {
        pid,
        type: safeString(metric.type) ?? 'unknown',
        workingSetMB: metricWorkingSetMB
      }
    }
  }

  const details: CrashReportDetails = { processMetricsCount: metrics.length }
  for (const bucketName of PROCESS_METRIC_BUCKETS) {
    const label = titleCaseBucket(bucketName)
    details[`processMetrics${label}Count`] = buckets[bucketName].count
    details[`processMetrics${label}WorkingSetMB`] = buckets[bucketName].workingSetMB
  }
  if (largest) {
    details.processMetricsLargestPid = largest.pid
    details.processMetricsLargestType = largest.type
    details.processMetricsLargestWorkingSetMB = largest.workingSetMB
  }
  return details
}

function getProcessGoneMetricDetails(): CrashReportDetails {
  try {
    return collectProcessGoneMetricDetails(app.getAppMetrics())
  } catch (error) {
    const errorName = error instanceof Error ? error.name : typeof error
    return { processMetricsError: errorName }
  }
}

export function buildProcessGoneCrashDetails(details: Record<string, unknown>): CrashReportDetails {
  const sanitizedDetails = sanitizeCrashReportDetails(details)
  // Why: low-JS-heap renderer kills can still be native/process memory pressure.
  // Capture Electron process buckets at process-gone time before recovery reloads.
  return {
    ...sanitizedDetails,
    ...getProcessGoneMetricDetails()
  }
}

export function buildSuppressedProcessGoneBreadcrumbData({
  source,
  processType,
  reason,
  exitCode,
  details
}: {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  details: Record<string, unknown>
}): CrashReportBreadcrumbData {
  const breadcrumb: CrashReportBreadcrumbData = {
    source,
    processType,
    reason,
    exitCode
  }
  const name = safeString(details.name)
  if (name) {
    breadcrumb.name = name
  }
  const serviceName = safeString(details.serviceName)
  if (serviceName) {
    breadcrumb.serviceName = serviceName
  }
  const type = safeString(details.type)
  if (type) {
    breadcrumb.type = type
  }
  return breadcrumb
}
