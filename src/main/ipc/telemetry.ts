// Treat renderer payloads as untrusted; track validates event schemas, while consent handlers narrow inputs, cap writes and derive provenance.

import { BrowserWindow, ipcMain } from 'electron'
import { consumeConsentMutationToken } from '../telemetry/burst-cap'
import {
  hasTrackedAgentDashboardActiveToday,
  persistBannerAcknowledgeWithoutEmitting,
  setOptIn,
  track
} from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { getOnboardingCohortAtEmit } from '../telemetry/onboarding-cohort-classifier'
import { resolveConsent, type ConsentState } from '../telemetry/consent'
import type { Store } from '../persistence'
import { isCohortExtendedEvent, isOnboardingEvent } from '../../shared/telemetry-events'
import type { EventName, EventProps, OptInVia } from '../../shared/telemetry-events'

// Derive consent provenance synchronously from pre-mutation settings.
let storeRef: Store | null = null

const MAIN_OWNED_TELEMETRY_EVENTS = new Set<EventName>([
  'agent_dashboard_enabled',
  'agent_token_usage',
  'app_starred_orca',
  'daemon_adopted',
  'daemon_async_io_health',
  'daemon_audit_eligibility',
  'daemon_pty_cwd_denied',
  'daemon_pty_cwd_readable',
  'star_nag_outcome',
  'feature_interaction_usage_bucket_reached',
  'ssh_remote_runtime_resolved',
  'ssh_host_server_decided',
  'ssh_host_server_conversion',
  'ssh_host_server_deploy_failed',
  'ssh_host_server_move',
  'ssh_host_server_legacy_relay_bridge',
  'wsl_move',
  'wsl_move_orchestrator',
  'wsl_usage_snapshot'
])

/** Only an existing user's first notice opt-out uses first_launch_banner; derive before writing consent. */
function deriveOptInVia(store: Store, incomingOptedIn: boolean): OptInVia {
  const telemetry = store.getSettings().telemetry
  const existedBefore = telemetry?.existedBeforeTelemetryRelease === true
  const currentOptedIn = telemetry?.optedIn

  // Renderer-provided opt-in cannot forge a first-notice opt-out provenance.
  if (existedBefore && currentOptedIn === null && incomingOptedIn === false) {
    return 'first_launch_banner'
  }

  return 'settings'
}

export function registerTelemetryHandlers(store: Store): void {
  storeRef = store

  ipcMain.handle('telemetry:track', (event, name: unknown, props: unknown): boolean => {
    if (typeof name !== 'string') {
      return false
    }
    if (props !== null && props !== undefined && typeof props !== 'object') {
      return false
    }
    const eventName = name as EventName
    // Renderer IPC must not spoof outcomes reserved for main-owned events.
    if (MAIN_OWNED_TELEMETRY_EVENTS.has(eventName)) {
      return false
    }
    if (eventName === 'agent_dashboard_active') {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) {
        return false
      }
    }
    // Inject cohort only where declared; strict event schemas reject extra fields.
    const baseProps = (props ?? {}) as Record<string, unknown>
    const withRepoCohort = isCohortExtendedEvent(eventName)
      ? { ...baseProps, ...getCohortAtEmit() }
      : baseProps
    const finalProps = isOnboardingEvent(eventName)
      ? { ...withRepoCohort, ...getOnboardingCohortAtEmit() }
      : withRepoCohort
    return (
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: track validates this IPC payload against its event schema before capture.
      track(eventName, finalProps as EventProps<EventName>) ||
      (eventName === 'agent_dashboard_active' && hasTrackedAgentDashboardActiveToday(finalProps))
    )
  })

  ipcMain.handle('telemetry:setOptIn', (_event, optedIn: unknown): Promise<void> | void => {
    if (typeof optedIn !== 'boolean') {
      return
    }
    // Do not consume limited mutation tokens when no store can accept the write.
    if (!storeRef) {
      return
    }
    if (!consumeConsentMutationToken()) {
      return
    }
    // Read provenance before consent mutation changes the pending-notice state.
    const via = deriveOptInVia(storeRef, optedIn)
    return setOptIn(via, optedIn)
  })

  // Privacy UI cannot directly read main's environment-based telemetry blocks.
  ipcMain.handle('telemetry:getConsentState', (): ConsentState => {
    if (!storeRef) {
      // Missing settings cannot establish enabled consent.
      return { effective: 'pending_banner' }
    }
    return resolveConsent(storeRef.getSettings())
  })

  ipcMain.handle('telemetry:acknowledgeBanner', (_event): Promise<void> | void => {
    // Silent banner acknowledgement must not emit telemetry_opted_in.
    if (!storeRef) {
      return
    }
    // Only a pending existing-user notice may silently opt in; resolved consent is immutable here.
    const telemetry = storeRef.getSettings().telemetry
    if (telemetry?.existedBeforeTelemetryRelease !== true || telemetry?.optedIn !== null) {
      return
    }
    // Silent acknowledgement also needs the disk-write mutation cap.
    if (!consumeConsentMutationToken()) {
      return
    }
    return persistBannerAcknowledgeWithoutEmitting()
  })
}

export function _resetStoreForTests(): void {
  storeRef = null
}
