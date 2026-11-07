import { renameSync } from 'node:fs'
import { resolveObservabilityConsent } from '../observability'
import { hasActiveTraceSink } from '../observability/tracer'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath,
  previousHangDetectionMarkerPath,
  type HangDetectionMarker
} from './hang-detection-marker'

export function preservePreviousHangDetection(userDataPath: string): void {
  if (!resolveObservabilityConsent().localFileEnabled) {
    return
  }
  try {
    // Keep the previous run's note safe from a new startup hang until its trace sink opens.
    renameSync(hangDetectionMarkerPath(userDataPath), previousHangDetectionMarkerPath(userDataPath))
  } catch {
    // Missing or inaccessible markers must not prevent startup; retain any earlier pending note.
  }
}

export function reportPreviousHangDetection(userDataPath: string): HangDetectionMarker | null {
  if (!hasActiveTraceSink()) {
    return null
  }
  const marker = consumeHangDetectionMarker(previousHangDetectionMarkerPath(userDataPath))
  if (marker) {
    recordDurableCrashBreadcrumb('main_thread_hang_detected', {
      unresponsiveMs: marker.unresponsiveMs,
      previousPid: marker.parentPid,
      selfRecovered: marker.selfRecovered,
      relaunched: marker.relaunched === true
    })
  }
  return marker
}
