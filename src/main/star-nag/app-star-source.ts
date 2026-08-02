import type { AppStarSource } from '../../shared/gh-star-source'
import type { StarNagPromptSource } from '../../shared/star-nag-telemetry'

export function getStarNagAppStarSource(source: StarNagPromptSource): AppStarSource {
  if (source === 'agent_value_moment' || source === 'onboarding_completed') {
    return source
  }
  return 'star_nag'
}
