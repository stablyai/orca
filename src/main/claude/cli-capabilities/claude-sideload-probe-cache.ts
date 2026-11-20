import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'
import type {
  ClaudeCliFlagFact,
  ClaudeCliFlagSupport,
  ClaudeCliLaunch
} from './claude-cli-flag-support'

const MAX_CONFIGS = 32

export function createClaudeSideloadProbe(deps: {
  accountKey: (launch: ClaudeCliLaunch) => string
  refused: (launch: ClaudeCliLaunch) => boolean
  remember: (launch: ClaudeCliLaunch, error: Error) => Promise<void>
}): NonNullable<ClaudeCliFlagSupport['probeSideload']> {
  const checked = new Map<string, ClaudeCliFlagFact>()
  const running = new Map<string, Promise<ClaudeCliFlagFact>>()
  const slots = new PrioritySemaphore(2)
  return async (launch, run) => {
    if (deps.refused(launch)) {
      return 'unsupported'
    }
    const account = deps.accountKey(launch)
    const known = checked.get(account)
    if (known) {
      return known
    }
    const existing = running.get(account)
    if (existing) {
      return existing
    }
    // Background preparation is optional; a later launch can retry admission after this burst.
    if (running.size >= MAX_CONFIGS) {
      return 'unknown'
    }
    const pending = (async (): Promise<ClaudeCliFlagFact> => {
      const release = await slots.acquire(0)
      let fact: ClaudeCliFlagFact = 'unknown'
      let checkedAccount = false
      try {
        if (deps.refused(launch)) {
          fact = 'unsupported'
          return fact
        }
        const result = await run()
        checkedAccount = !result.skipped
        if (!result.timedOut) {
          await deps.remember(launch, new Error(`${result.stderr}\n${result.stdout}`))
          if (deps.refused(launch)) {
            fact = 'unsupported'
          } else if (
            result.code !== 0 &&
            result.stderr.includes(
              'Input must be provided either through stdin or as a prompt argument when using --print'
            )
          ) {
            fact = 'supported'
          }
        }
        return fact
      } catch {
        return fact
      } finally {
        release()
        running.delete(account)
        if (checkedAccount) {
          checked.set(account, fact)
        }
      }
    })()
    running.set(account, pending)
    return pending
  }
}
