import { BROWSER_EXPECT_URL_RUNTIME_CAPABILITY } from '../../shared/browser/runtime/browser-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getOptionalStringFlag, getPresentStringFlag } from '../arguments/flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveBrowserPageReference } from '../tab-reference/copied-tab-reference'
import { assertLocalCwdWorktreeSelector } from '../hosts/local-environment-selector'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'
import { hasStructuredSessionMarker } from '../../shared/agent-launch/environment/structured-session-marker'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  getBrowserWorktreeSelector,
  normalizeWorktreeSelectorForCaller,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'

type BrowserCliTarget = {
  worktree?: string
  page?: string
  expectUrl?: string
}

export async function getBrowserCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<BrowserCliTarget> {
  const expectUrl = await getEnforceableExpectUrl(flags, client)
  const target = await getBrowserPageTarget(flags, cwd, client)
  return expectUrl === undefined ? target : { ...target, expectUrl }
}

// Older runtimes drop unknown params and would act unguarded, so refuse before sending.
async function getEnforceableExpectUrl(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  // An empty value, like an unset shell variable, must fail rather than run unguarded.
  const expectUrl = getPresentStringFlag(flags, 'expect-url')
  if (expectUrl === undefined) {
    return undefined
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(BROWSER_EXPECT_URL_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca runtime cannot check --expect-url yet. Update Orca on it or drop the flag.'
    )
  }
  return expectUrl
}

/** Unscoped commands fall back to the tab a person is looking at, so remote callers and chat agents must name their target. */
export async function getScopedBrowserWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  if (worktree !== undefined) {
    return worktree
  }
  // Why: chat agents have no terminal workspace (#41282), so outside a workspace folder they would drive the user's tab.
  if (!client.isRemote && (hasStructuredSessionMarker() || readInjectedAgentSessionId())) {
    throw new RuntimeClientError(
      'invalid_argument',
      'This browser command names no workspace or page, so it would act on the tab the user is looking at. Nothing was sent.',
      {
        nextSteps: [
          'Run it from your workspace folder or pass --worktree <selector>; page commands also take --page <browserPageId> from `orca tab list --json`.'
        ]
      }
    )
  }
  if (client.isRemote) {
    const environment = client.environmentSelector
    const remote = environment
      ? ` --environment ${quoteCliCommandArgument(environment)}`
      : ' --pairing-code <the same code>'
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote browser commands need --page <browserPageId> or a server-side --worktree <selector> (not `all`); without one they would act on the tab the user is looking at. Nothing was sent.',
      {
        nextSteps: [
          `Find the page with \`orca tab list${remote} --json\` and pass its browserPageId as --page.`
        ]
      }
    )
  }
  return worktree
}

async function getBrowserPageTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<BrowserCliTarget> {
  const pageFlag = getOptionalStringFlag(flags, 'page')
  if (!pageFlag) {
    return { worktree: await getScopedBrowserWorktreeSelector(flags, cwd, client) }
  }
  const page = await resolveBrowserPageReference(client, pageFlag)

  const explicitWorktree = getOptionalStringFlag(flags, 'worktree')
  if (!explicitWorktree || explicitWorktree === 'all') {
    return { page }
  }
  if (explicitWorktree === 'active' || explicitWorktree === 'current') {
    assertLocalCwdWorktreeSelector(explicitWorktree, client)
    return { page, worktree: await resolveCurrentWorktreeSelector(cwd, client) }
  }
  return {
    page,
    worktree: await normalizeWorktreeSelectorForCaller(explicitWorktree, cwd, client)
  }
}
