import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalNonNegativeIntegerFlag, getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  STATS_USAGE_MAX_SESSIONS,
  STATS_USAGE_PROVIDERS,
  STATS_USAGE_RANGES,
  STATS_USAGE_SCOPES,
  type StatsUsageParams
} from '../../shared/rpc-contract/host-management/stats-usage-params'
import { formatStatsUsage, type StatsUsageResult } from './stats-usage-format'

function getChoiceFlag<T extends string>(
  flags: Map<string, string | boolean>,
  name: string,
  choices: readonly T[]
): T | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const choice = choices.find((candidate) => candidate === value)
  if (!choice) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be ${choices.join(', ')}`)
  }
  return choice
}

export const STATS_HANDLERS: Record<string, CommandHandler> = {
  'stats usage': async ({ client, flags, json }) => {
    const provider = getChoiceFlag(flags, 'provider', STATS_USAGE_PROVIDERS)
    if (!provider) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Missing required --provider (${STATS_USAGE_PROVIDERS.join(', ')})`
      )
    }
    const sessions = getOptionalNonNegativeIntegerFlag(flags, 'sessions')
    if (sessions !== undefined && sessions > STATS_USAGE_MAX_SESSIONS) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--sessions must be at most ${STATS_USAGE_MAX_SESSIONS}`
      )
    }
    const params: StatsUsageParams = {
      provider,
      range: getChoiceFlag(flags, 'range', STATS_USAGE_RANGES),
      scope: getChoiceFlag(flags, 'scope', STATS_USAGE_SCOPES),
      sessions
    }
    try {
      const result = await client.call<StatsUsageResult>('stats.usage', params)
      printResult(result, json, formatStatsUsage)
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This Orca host does not support stats usage yet. Update Orca on that host and try again.'
        )
      }
      throw error
    }
  }
}
