import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import type { ClaudeProfileRoutingService } from './claude-profile-routing-service'

let authority: ClaudeProfileRoutingService | undefined
/** Installed by the execution host; no settings/env/UI switch enables this dormant rollout. */
export function installClaudeProfileRoutingAuthority(value: ClaudeProfileRoutingService): void {
  authority = value
}
/** Undefined where no owner is installed (headless hosts, worker threads, child processes): those
 *  launch and read System Default, and out-of-process readers get profile roots from their parent. */
export function getClaudeProfileRoutingAuthority(): ClaudeProfileRoutingService | undefined {
  return claudeProfileRoutingEnabled() ? authority : undefined
}
