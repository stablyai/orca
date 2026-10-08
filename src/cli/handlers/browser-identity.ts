import type {
  BrowserIdentityModeSetResult,
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../shared/browser-user-agent-mode'
import { BROWSER_IDENTITY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

async function assertBrowserIdentitySupported({ client }: HandlerContext): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(BROWSER_IDENTITY_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime does not support browser identity management. Update or restart Orca and try again.'
    )
  }
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
    return `Browser identity: ${identity.state}; Cleaned is applied for this launch. Explicit reset required.`
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
