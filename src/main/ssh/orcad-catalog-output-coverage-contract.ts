import { z } from 'zod'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from './orcad-catalog-activation-contract'

const sequence = z.number().int().nonnegative().safe()

export function parseOrcadCatalogOutputCoverageRequest(
  value: Parameters<typeof parseOrcadCatalogActivationRequest>[0] & { throughSeq: unknown }
) {
  return {
    ...parseOrcadCatalogActivationRequest(value),
    throughSeq: sequence.parse(value.throughSeq)
  }
}

export function parseOrcadCatalogOutputCoverageResult(
  value: unknown,
  expected: ReturnType<typeof parseOrcadCatalogOutputCoverageRequest>
) {
  const activation = parseOrcadCatalogActivationResult(value, expected)
  const { coverage } = z
    .object({
      coverage: z.object({
        throughSeq: sequence,
        acknowledgedEndSeq: sequence,
        modelThroughSeq: sequence,
        modelSequenceEnd: sequence
      })
    })
    .parse(value)
  if (
    coverage.throughSeq !== expected.throughSeq ||
    coverage.acknowledgedEndSeq < expected.throughSeq ||
    coverage.modelThroughSeq < expected.throughSeq
  ) {
    throw new Error('orcad_catalog_output_coverage_incomplete')
  }
  return { ...activation, coverage }
}
