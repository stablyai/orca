import { z } from 'zod'
import {
  DIAGNOSTIC_BUNDLE_CATEGORIES,
  MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES,
  type DiagnosticBundleCategory
} from '../../../../shared/diagnostic-bundle-export-types'
import { defineMethod, type RpcMethod } from '../core'

const DiagnosticBundleCategory = z.enum(DIAGNOSTIC_BUNDLE_CATEGORIES)

const DiagnosticBundleParams = z
  .object({
    output: z.string().min(1).optional(),
    lookbackMinutes: z
      .number()
      .int()
      .positive()
      .max(MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES)
      .optional(),
    include: z.array(DiagnosticBundleCategory).optional(),
    exclude: z.array(DiagnosticBundleCategory).optional(),
    open: z.boolean().optional()
  })
  .strict()

export const DIAGNOSTICS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'diagnostics.memory',
    params: null,
    handler: async (_params, { runtime }) => {
      return await runtime.getMemorySnapshot()
    }
  }),
  defineMethod({
    name: 'diagnostics.bundle',
    params: DiagnosticBundleParams,
    handler: async (params, { runtime }) => {
      return await runtime.createDiagnosticBundle({
        ...params,
        include: params.include as DiagnosticBundleCategory[] | undefined,
        exclude: params.exclude as DiagnosticBundleCategory[] | undefined
      })
    }
  })
]
