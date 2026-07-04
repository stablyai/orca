import type { MemorySnapshot } from '../../shared/types'
import {
  MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES,
  type DiagnosticBundleExportResult
} from '../../shared/diagnostic-bundle-export-types'
import {
  DIAGNOSTIC_OUTPUT_PATH_ERROR,
  isSafeDiagnosticBundleOutputPath
} from '../../shared/diagnostic-bundle-output-path-policy'
import type { CommandHandler } from '../dispatch'
import { formatDiagnosticBundleExportResult, formatMemorySnapshot, printResult } from '../format'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export const DIAGNOSTICS_HANDLERS: Record<string, CommandHandler> = {
  'diagnostics memory': async ({ client, json }) => {
    const result = await client.call<MemorySnapshot>('diagnostics.memory')
    printResult(result, json, formatMemorySnapshot)
  },
  'diagnostics bundle': async ({ client, flags, json }) => {
    const params = {
      output: parseOutputPath(getOptionalStringFlag(flags, 'output')),
      lookbackMinutes: parseLookbackMinutes(getOptionalStringFlag(flags, 'lookback')),
      include: optionalArray(getRepeatedStringFlag(flags, 'include')),
      exclude: optionalArray(getRepeatedStringFlag(flags, 'exclude')),
      open: flags.get('open') === true ? true : undefined
    }
    const result = await client.call<DiagnosticBundleExportResult>('diagnostics.bundle', params)
    printResult(result, json, formatDiagnosticBundleExportResult)
  }
}

function optionalArray(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined
}

function parseLookbackMinutes(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const match = /^(\d+)([mhd])?$/.exec(value.trim().toLowerCase())
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid --lookback value. Use minutes, or suffix with m, h, or d.'
    )
  }
  const amount = Number.parseInt(match[1], 10)
  const unit = match[2] ?? 'm'
  const multiplier = unit === 'd' ? 24 * 60 : unit === 'h' ? 60 : 1
  const minutes = amount * multiplier
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid --lookback value. Use a range from 1m through 30d.'
    )
  }
  return minutes
}

function parseOutputPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  if (!isSafeDiagnosticBundleOutputPath(value)) {
    throw new RuntimeClientError('invalid_argument', DIAGNOSTIC_OUTPUT_PATH_ERROR)
  }
  return value
}
