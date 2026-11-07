import type { RateLimitRuntimeTarget } from '../../../shared/rate-limit-types'
import type {
  AntigravityAccountUsageRecorder,
  AntigravityUsageReadStart
} from '../antigravity-account-usage'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { ProviderRateLimits } from './service-types'

type AntigravityAccountRead = AntigravityUsageReadStart & { target: RateLimitRuntimeTarget }

export abstract class RateLimitServiceAntigravityAccounts extends RateLimitServiceFetchPolicy {
  protected async beginAntigravityAccountRead(
    recorder: AntigravityAccountUsageRecorder
  ): Promise<AntigravityAccountRead | null> {
    const target = this.antigravityFetchTarget
    try {
      const read = await recorder.begin(target)
      if (target !== this.antigravityFetchTarget) {
        // Retargeted mid-read: these accounts belong to the previous runtime.
        return null
      }
      this.antigravityAccounts = read?.accounts ?? []
      return read && { ...read, target }
    } catch {
      // Unverifiable identity leaves the live reading unattributed, as before accounts existed.
      return null
    }
  }

  protected async attributeAntigravityReading(
    read: AntigravityAccountRead | null,
    generation: number,
    limits: ProviderRateLimits
  ): Promise<ProviderRateLimits> {
    const recorder = this.antigravityAccountUsageRecorder
    if (!read?.login || !recorder) {
      return limits
    }
    let finish
    try {
      finish = await recorder.finish(read.target, read.login, limits)
    } catch {
      return limits
    }
    if (generation !== this.antigravityFetchGeneration) {
      return limits
    }
    if (finish.switched) {
      // The reading may belong to either login, so drop it rather than misattribute it.
      this.antigravityFetchGeneration += 1
      this.updateState({ ...this.state, antigravity: null })
      return limits
    }
    this.antigravityAccounts = finish.accounts
    return { ...limits, usageMetadata: { ...limits.usageMetadata, account: finish.account } }
  }
}
