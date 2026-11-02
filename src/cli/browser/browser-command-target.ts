import { BROWSER_EXPECT_URL_RUNTIME_CAPABILITY } from '../../shared/browser-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getOptionalStringFlag, getPresentStringFlag } from '../flags'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import {
  assertLocalCwdWorktreeSelector,
  getBrowserWorktreeSelector,
  normalizeWorktreeSelectorForCaller,
  resolveCurrentWorktreeSelector
} from '../selectors'

export type BrowserCliTarget = {
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

async function getBrowserPageTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<BrowserCliTarget> {
  const page = getOptionalStringFlag(flags, 'page')
  if (!page) {
    return { worktree: await getBrowserWorktreeSelector(flags, cwd, client) }
  }

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
