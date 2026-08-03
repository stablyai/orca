import { z } from 'zod'
import {
  ORCHESTRATION_REPORT_DISPATCH_LIMIT,
  ORCHESTRATION_REPORT_TASK_LIMIT
} from '../../../../shared/orchestration-cost-report'
import { buildOrchestrationCostReport } from '../../orchestration/cost-report'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const ReportParams = z.object({ id: requiredString('Missing --id') })

export const ORCHESTRATION_REPORT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.report',
    params: ReportParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const completedAt = db.getRunReportCompletionAt(params.id)
      if (completedAt === undefined) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const usageSnapshots = await runtime.getOrchestrationUsageSnapshots(completedAt)
      const finalRecords = db.getRunReportRecords(params.id, {
        tasks: ORCHESTRATION_REPORT_TASK_LIMIT,
        dispatches: ORCHESTRATION_REPORT_DISPATCH_LIMIT
      })
      if (!finalRecords) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const worktreeHosts = [
        ...new Set(
          finalRecords.dispatches.flatMap((row) => (row.worktree_id ? [row.worktree_id] : []))
        )
      ]
        .sort()
        .map((worktreeId) => ({
          worktreeId,
          scope: runtime.resolveOrchestrationReportWorktreeHostScope(worktreeId)
        }))
      return buildOrchestrationCostReport({
        records: finalRecords,
        usageSnapshots,
        worktreeHosts,
        generatedAt: new Date().toISOString()
      })
    }
  })
]
