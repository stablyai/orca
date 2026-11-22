import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../shared/browser/identity/browser-user-agent-mode'
import { BROWSER_IDENTITY_RUNTIME_CAPABILITY } from '../../shared/browser/runtime/browser-runtime-capabilities'
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY
} from '../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'

async function assertBrowserIdentitySupported({ client }: HandlerContext): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  const capabilities = status.result.capabilities ?? []
  if (capabilities.includes(BROWSER_IDENTITY_RUNTIME_CAPABILITY)) {
    return
  }
  // Only a host's Orca server serves the desktop bridge, and it has no identity setting of its own.
  if (capabilities.includes(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      "Browser identity is a setting of the Orca desktop app, and this host's Orca server has none. Change it on your desktop in Settings › Browser."
    )
  }
  throw new RuntimeClientError(
    'incompatible_runtime',
    'The running Orca runtime does not support browser identity management. Update or restart Orca and try again.'
  )
}

function parseMode(flags: Map<string, string | boolean>): BrowserUserAgentMode {
  const mode = getRequiredStringFlag(flags, 'mode')
  if (mode !== 'clean' && mode !== 'native') {
    throw new RuntimeClientError('invalid_argument', '--mode must be "clean" or "native"')
  }
  return mode
}

function formatStatus(status: BrowserIdentityModeStatus): string {
  const { identity } = status
  if (identity.configuredMode === null) {
    return `Browser identity: ${identity.state}; ${identity.appliedMode} is applied for this launch. Explicit reset required.`
  }
  return `Browser identity: ${identity.configuredMode} (applied: ${identity.appliedMode}${identity.restartRequired ? ', restart required' : ''})`
}

export const BROWSER_IDENTITY_HANDLERS: Record<string, CommandHandler> = {
  'browser identity get': async (context) => {
    await assertBrowserIdentitySupported(context)
    const result = await context.client.call<BrowserIdentityModeStatus>('browser.identity.get')
    printResult(result, context.json, formatStatus)
  },
  'browser identity set': async (context) => {
    const mode = parseMode(context.flags)
    // Opt-in only: without it the host refuses to overwrite corrupt or newer-version data.
    const reset = context.flags.get('reset') === true
    await assertBrowserIdentitySupported(context)
    const result = await context.client.call<BrowserIdentityModeSetResult>('browser.identity.set', {
      mode,
      ...(reset ? { reset: true } : {})
    })
    if (!result.result.ok) {
      throw new RuntimeClientError(result.result.error.code, result.result.error.message)
    }
    printResult(result, context.json, ({ identity }) =>
      identity.restartRequired
        ? `Browser identity set to ${identity.configuredMode}; restart Orca to apply it.`
        : `Browser identity set to ${identity.configuredMode}.`
    )
  }
}
