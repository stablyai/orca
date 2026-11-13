import type { SettledProviderResult } from './service-sibling-provider-result'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import type { InternalRateLimitState } from './service-types'
import type { NormalizedClaudeAccountSelectionTarget } from '../../claude-accounts/selection/runtime-selection'
import type { NormalizedCodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'

export type FetchAllCyclePrepared = {
  claudeTarget: NormalizedClaudeAccountSelectionTarget
  claudeGeneration: number
  claudeAuthPreparation: ClaudeRuntimeAuthPreparation | undefined
  claudeProvenance: string
  codexTarget: NormalizedCodexAccountSelectionTarget
  previousState: InternalRateLimitState
  codexFetchGated: boolean
  codexStateBeforeFetch: ProviderRateLimits | null
  codexProvenance: string | null
  codexHomePath: string | null
  codexGeneration: number
  opencodeConfigChanged: boolean
  opencodeGeneration: number
  miniMaxConfigChanged: boolean
  miniMaxGeneration: number
  zcodeConfigChanged: boolean
  zcodeGeneration: number
  antigravityGeneration: number
  claudeFetchGated: boolean
  results: [
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>,
    PromiseSettledResult<ProviderRateLimits>
  ]
  grokResultPromise: Promise<SettledProviderResult>
  cursorResultPromise: Promise<SettledProviderResult>
  zcodeResultPromise: Promise<SettledProviderResult>
  antigravityResultPromise: Promise<SettledProviderResult>
}
