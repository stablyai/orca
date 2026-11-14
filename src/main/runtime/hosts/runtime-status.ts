import {
  BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_IDENTITY_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
} from '../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserCommandsFactorySupportsGoogleCookieClear,
  runtimeBrowserCommandsFactorySupportsClientHosting,
  runtimeBrowserUnavailableCause
} from '../browser/installation/runtime-browser-commands-factory'
import { isBrowserIdentityModeStoreInitialized } from '../../browser/identity/mode/browser-identity-mode-store'
import { servesLocalWslMigrationSource } from '../../orcad/migration/orcad-migration-wsl-destination'
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/orcad-runtime-capabilities'
import { advertisedOrcadMigrationDestinationCapabilities } from '../../orcad/migration/orcad-migration-destination-capabilities'
import { USAGE_CREDENTIALS_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

import {
  MANAGED_SERVER_RUNTIME_CAPABILITY,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
} from '../../../shared/host-runtime-capabilities'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import {
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
} from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import type { RuntimeDegradation } from '../../../shared/runtime-capability-degradation'

import {
  type RuntimeStatus,
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage
} from '../../../shared/runtime-session-contracts'
import {
  TERMINAL_PERSISTENCE_DEGRADATION_CAPABILITY,
  TERMINAL_PERSISTENCE_UNAVAILABLE_CODE,
  TERMINAL_PERSISTENCE_UNAVAILABLE_MESSAGE
} from '../../../shared/runtime-capability-degradation'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../shared/mobile-web-bundle/mobile-web-bundle-capability'
import { getBundledMobileWebBundleRoot } from '../rpc/methods/mobile-delivery/bundled-mobile-web-bundle'
import { runtimeTerminalDegradation } from '../terminal/launch/native-terminal-availability'
import { isWindowsProcessStartTimeAvailable } from '../../windows/windows-process-table'
import { WORKTREE_CREATE_RESULT_TTL_MS } from '../workspaces/creation/worktree-create-idempotency'

import { MACHINE_NAME_PUBLISH_WAIT_MS } from './platform-probe/runtime-machine-name'
import { getManagedServerActions } from './management/managed-server-actions-registry'
import { getRecipeVmWaker } from '../workspaces/sleep/recipe-vm-waker-registry'
import { HOST_RECIPE_VM_WAKE_CAPABILITY } from '../../../shared/remote-runtime/recipe-vm-wake'
import { isDesktopBrowserBridgeHostEnabled } from '../desktop-browser-bridge/desktop-browser-bridge-registry'
import { DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY } from '../../../shared/desktop-browser-bridge-protocol'
import { darkSwitchRuntimeCapabilities } from '../construction/dark-switch-runtime-capabilities'
import { supportsDurableTerminalPromptDelivery } from '../terminal/input/durable-terminal-prompt-delivery-support'
import { RuntimeWorkspaceChangeEvents } from '../workspaces/catalog/runtime-workspace-change-events'

export abstract class OrcaRuntimeWithGetStatus extends RuntimeWorkspaceChangeEvents {
  getStatus(): RuntimeStatus {
    // Advertise screencast for renderer/offscreen backends; headless ownership prevents client-local fallback.
    const hasRenderer = Boolean(this.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.offscreenBrowserBackend)
    const hasHeadlessCommands = runtimeBrowserCommandsFactoryIsHeadless()
    const canBrowse = hasRenderer || hasOffscreen
    const canHostClientPages = runtimeBrowserCommandsFactorySupportsClientHosting()
    // TEMPORARY compatibility field: older clients otherwise re-probe WSL capabilities indefinitely.
    const windowsProcessStartTimeAvailable =
      process.platform === 'win32' && isWindowsProcessStartTimeAvailable()
    const capabilities: NonNullable<RuntimeStatus['capabilities']> = RUNTIME_CAPABILITIES.filter(
      (capability) =>
        (capability !== BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY ||
          runtimeBrowserCommandsFactorySupportsGoogleCookieClear()) &&
        (capability !== 'browser.screencast.v1' || canBrowse) &&
        (capability !== BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY || canHostClientPages) &&
        (capability !== BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY ||
          canBrowse ||
          hasHeadlessCommands ||
          canHostClientPages) &&
        // Nested-runtime E2E exercises legacy transport without maintaining an old binary.
        (process.env.ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL !== '1' ||
          capability !== REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1' ||
          capability !== TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1' ||
          capability !== SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY) &&
        (capability !== TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY ||
          supportsDurableTerminalPromptDelivery()) &&
        // Only hosts running their own usage poller can consume saved keys.
        (capability !== USAGE_CREDENTIALS_RUNTIME_CAPABILITY || this.getUsageRateLimits() !== null)
    )
    if (hasOffscreen || hasHeadlessCommands) {
      capabilities.push(BROWSER_HEADLESS_RUNTIME_CAPABILITY)
    }
    // Only initialized identity stores can serve this process-wide, pre-ready mode.
    if (isBrowserIdentityModeStoreInitialized()) {
      capabilities.push(BROWSER_IDENTITY_RUNTIME_CAPABILITY)
    }
    // Only the daemon inside a distro can receive that distro's projects.
    if (servesLocalWslMigrationSource()) {
      capabilities.push(ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY)
    }
    // Advertise only installed blob kinds; senders refuse unsupported kinds instead of silently losing staged data.
    capabilities.push(...advertisedOrcadMigrationDestinationCapabilities())
    // Certificate proceed belongs to whichever process hosts the page, renderer or offscreen.
    if (canBrowse) {
      capabilities.push(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY)
    }
    if (getManagedServerActions()) {
      capabilities.push(MANAGED_SERVER_RUNTIME_CAPABILITY)
    }
    if (getRecipeVmWaker()) {
      capabilities.push(HOST_RECIPE_VM_WAKE_CAPABILITY)
    }
    if (isDesktopBrowserBridgeHostEnabled()) {
      capabilities.push(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)
    }
    capabilities.push(...darkSwitchRuntimeCapabilities())
    // Dev/serve installs may lack out/mobile-web; advertise downloads only where the install ships it.
    if (getBundledMobileWebBundleRoot()) {
      capabilities.push(MOBILE_WEB_BUNDLE_CAPABILITY)
    }
    // Report the actual failure so operators are not told to fix already-correct configuration.
    const cause = canBrowse || hasHeadlessCommands ? null : runtimeBrowserUnavailableCause()
    const degradations: RuntimeDegradation[] = cause
      ? [
          {
            code: BROWSER_UNAVAILABLE_ERROR_CODE,
            capability: BROWSER_HEADLESS_RUNTIME_CAPABILITY,
            message: browserUnavailableMessage(cause.reason, cause.detail),
            reason: cause.reason,
            ...(cause.detail ? { detail: cause.detail } : {})
          }
        ]
      : []
    const terminalDegradation = runtimeTerminalDegradation()
    if (terminalDegradation) {
      degradations.push(terminalDegradation)
    }
    // Hosts that never wire this check default to true and claim nothing.
    if (!this.canRecoverPersistentLocalPtysFn()) {
      degradations.push({
        code: TERMINAL_PERSISTENCE_UNAVAILABLE_CODE,
        capability: TERMINAL_PERSISTENCE_DEGRADATION_CAPABILITY,
        message: TERMINAL_PERSISTENCE_UNAVAILABLE_MESSAGE
      })
    }
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      desktopWindowStatus: hasRenderer ? 'available' : this.getDesktopWindowStatusFn(),
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_RESULT_TTL_MS },
      ...(windowsProcessStartTimeAvailable ? { windowsProcessStartTimeAvailable } : {}),
      hostPlatform: process.platform,
      machineName: this.readMachineName(),
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }

  readMachineName(): string {
    return this.machineName.read()
  }

  readPairedDeviceName(deviceId: string): string | null {
    return this.getPairedDeviceNameFn(deviceId)
  }

  /** Bound machine-name lookup; slow lookups temporarily publish hostname, then their result on the next read. */
  machineNameReady(): Promise<void> {
    return this.machineName.readyWithin(MACHINE_NAME_PUBLISH_WAIT_MS)
  }
}
