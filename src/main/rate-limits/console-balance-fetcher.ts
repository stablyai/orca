import { net } from 'electron'
import type { ConsoleBalance } from '../../types/console-api'

export class ConsoleBalanceFetcher {
  private defaultEndpoint = 'https://console.claude.ai/api'

  async fetch(apiKey: string, endpoint?: string, signal?: AbortSignal): Promise<ConsoleBalance> {
    try {
      // Inside the try: a malformed custom endpoint should surface as a fetch
      // failure, not a bare TypeError from the URL constructor.
      const base = (endpoint || this.defaultEndpoint).replace(/\/?$/, '/')
      const url = new URL('organizations/balance', base)
      const timeoutSignal = AbortSignal.timeout(10_000)

      const response = await net.fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      })

      if (!response.ok) {
        throw new Error(`Console API ${response.status}: ${response.statusText}`)
      }

      const data = (await response.json()) as unknown
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('Console API response must be an object')
      }
      const typedData = data as Record<string, unknown>

      if (typeof typedData.id !== 'string') {
        throw new Error('Console API response missing or invalid id field')
      }
      // isFinite as well as typeof: Infinity/NaN would propagate as a cents total.
      if (
        typeof typedData.balance_in_cents !== 'number' ||
        !Number.isFinite(typedData.balance_in_cents)
      ) {
        throw new Error('Console API response missing or invalid balance_in_cents field')
      }

      let spendRate: number | undefined
      if (typedData.spending_metrics && typeof typedData.spending_metrics === 'object') {
        const metrics = typedData.spending_metrics as Record<string, unknown>
        if (
          typeof metrics.spend_rate_cents_per_hour === 'number' &&
          Number.isFinite(metrics.spend_rate_cents_per_hour)
        ) {
          spendRate = metrics.spend_rate_cents_per_hour
        }
      }

      return {
        organization_id: typedData.id,
        balance_in_cents: typedData.balance_in_cents,
        spend_rate_cents_per_hour: spendRate,
        last_fetched_at: Date.now()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to fetch console balance: ${message}`)
    }
  }
}
