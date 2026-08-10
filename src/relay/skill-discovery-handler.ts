import { homedir } from 'node:os'
import { discoverSkills } from '../main/skills/discovery'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { SkillDiscoveryResult } from '../shared/skills'

/** Below the desktop provider's 9s request timeout so the classified timeout
 *  error, not a generic transport timeout, is what reaches the picker. */
const SCAN_BUDGET_MS = 8_000
const MAX_CWD_LENGTH = 4096

export class SkillDiscoveryHandler {
  constructor(dispatcher: RelayDispatcher) {
    // Why: new method name — pre-skill relays answer -32601 so the desktop can
    // prompt a reconnect instead of showing an empty skill list.
    dispatcher.onRequest('skills.discover', (params, context) => this.discover(params, context))
  }

  private async discover(
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<SkillDiscoveryResult> {
    const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : ''
    if (!cwd || cwd.length > MAX_CWD_LENGTH) {
      throw new Error('Invalid skill discovery cwd')
    }
    const budget = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      budget.abort()
    }, SCAN_BUDGET_MS)
    const onClientAbort = (): void => budget.abort()
    if (context.signal?.aborted) {
      budget.abort()
    } else {
      context.signal?.addEventListener('abort', onClientAbort, { once: true })
    }
    try {
      // Why: repos [] + relay-derived home keeps the scan targeted to this cwd's
      // known skill roots; the client never supplies remote path semantics.
      return await discoverSkills({
        repos: [],
        cwd,
        homeDir: homedir(),
        signal: budget.signal
      })
    } catch (error) {
      if (timedOut) {
        throw new Error('Skill discovery timed out on the SSH host')
      }
      throw error
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onClientAbort)
    }
  }
}
