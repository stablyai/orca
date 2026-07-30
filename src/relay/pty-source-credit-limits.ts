import { assertPositiveSafeInteger } from '../shared/pty-source-credit-validation'
import {
  DEFAULT_AGGREGATE_RETAINED_DATA_BYTES,
  DEFAULT_AGGREGATE_RETAINED_SPANS,
  DEFAULT_AGGREGATE_RETAINED_SOURCE_SU,
  DEFAULT_RETAINED_DATA_BYTES,
  DEFAULT_RETAINED_SPANS,
  DEFAULT_RETAINED_SOURCE_SU
} from './pty-source-credit-record'

export type PtySourceCreditLedgerOptions = {
  maxRetainedSourceSu?: number
  maxAggregateRetainedSourceSu?: number
  maxRetainedDataBytes?: number
  maxAggregateRetainedDataBytes?: number
  maxRetainedSpans?: number
  maxAggregateRetainedSpans?: number
}

export type PtySourceCreditLimits = Required<PtySourceCreditLedgerOptions>

export function resolvePtySourceCreditLimits(
  options: PtySourceCreditLedgerOptions
): PtySourceCreditLimits {
  const limits = {
    maxRetainedSourceSu: options.maxRetainedSourceSu ?? DEFAULT_RETAINED_SOURCE_SU,
    maxAggregateRetainedSourceSu:
      options.maxAggregateRetainedSourceSu ?? DEFAULT_AGGREGATE_RETAINED_SOURCE_SU,
    maxRetainedDataBytes: options.maxRetainedDataBytes ?? DEFAULT_RETAINED_DATA_BYTES,
    maxAggregateRetainedDataBytes:
      options.maxAggregateRetainedDataBytes ?? DEFAULT_AGGREGATE_RETAINED_DATA_BYTES,
    maxRetainedSpans: options.maxRetainedSpans ?? DEFAULT_RETAINED_SPANS,
    maxAggregateRetainedSpans: options.maxAggregateRetainedSpans ?? DEFAULT_AGGREGATE_RETAINED_SPANS
  }
  for (const [name, value] of Object.entries(limits)) {
    assertPositiveSafeInteger(value, name)
  }
  return Object.freeze(limits)
}
