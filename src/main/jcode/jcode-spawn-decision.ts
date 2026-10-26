import type { JcodeSpawnRequest } from '../../shared/jcode-spawn-hook'

export type JcodeSpawnDecision =
  | { action: 'open-child' }
  | { action: 'focus'; paneKey: string; waitForCreation: boolean }
  | { action: 'open-plain' }

export function decideJcodeSpawn(
  request: JcodeSpawnRequest,
  facts: {
    rootSessionId: string | undefined
    owner:
      | { paneKey: string; role: 'root' | 'worker' | 'plain'; state: 'creating' | 'open' }
      | undefined
  }
): JcodeSpawnDecision {
  if (facts.owner) {
    return {
      action: 'focus',
      paneKey: facts.owner.paneKey,
      waitForCreation: facts.owner.state === 'creating'
    }
  }
  if (
    request.kind === 'swarm-agent' &&
    facts.rootSessionId !== undefined &&
    facts.rootSessionId === request.coordinatorSessionId
  ) {
    return { action: 'open-child' }
  }
  return { action: 'open-plain' }
}
