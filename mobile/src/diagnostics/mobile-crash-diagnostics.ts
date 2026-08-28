import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { Platform, Share } from 'react-native'
import { MobileCrashSessionJournal, type MobileCrashSessionSnapshot } from './mobile-crash-session'

const journal = new MobileCrashSessionJournal(AsyncStorage)

export function startMobileCrashSession(): Promise<MobileCrashSessionSnapshot | null> {
  return journal.start()
}

export function recordMobileRouteBreadcrumb(segments: readonly string[]): Promise<void> {
  return journal.recordRoute(segments)
}

export function recordMobileAppState(state: string): Promise<void> {
  return journal.recordAppState(state)
}

export function recordMobileRenderError(
  error: unknown,
  componentStack?: string | null
): Promise<void> {
  return journal.recordRenderError(error, componentStack)
}

export function getPreviousMobileCrashSession(): Promise<MobileCrashSessionSnapshot | null> {
  return journal.getLatestAbnormalSession()
}

export function getUndismissedPreviousMobileCrashSession(): Promise<MobileCrashSessionSnapshot | null> {
  return journal.getUndismissedLatestAbnormalSession()
}

export function dismissPreviousMobileCrashSession(openedAt: string): Promise<void> {
  return journal.dismissLatestAbnormalSession(openedAt)
}

export function buildMobileCrashDiagnosticsReport(): Promise<string> {
  return journal.buildReport({
    version: Constants.expoConfig?.version ?? 'unknown',
    platform: `${Platform.OS} ${Platform.Version ?? ''}`.trim()
  })
}

export async function shareMobileCrashDiagnostics(): Promise<void> {
  await Share.share({
    title: 'Orca Mobile crash diagnostics',
    message: await buildMobileCrashDiagnosticsReport()
  })
}
