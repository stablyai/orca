import type { SettledProviderResult } from './service-sibling-provider-result'
import type {
  ClaudeRuntimeAuthPreparation,
  InternalRateLimitState,
  NormalizedClaudeAccountSelectionTarget,
  NormalizedCodexAccountSelectionTarget,
  ProviderRateLimits
} from './service-types'

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
  codexGeneration: number
  opencodeConfigChanged: boolean
  opencodeGeneration: number
  miniMaxConfigChanged: boolean
  miniMaxGeneration: number
  zcodeConfigChanged: boolean
  zcodeGeneration: number
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
