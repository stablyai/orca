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
    handler: (params, { runtime }) => {
      const records = runtime.getOrchestrationDb().getRunReportRecords(params.id, {
        tasks: ORCHESTRATION_REPORT_TASK_LIMIT,
        dispatches: ORCHESTRATION_REPORT_DISPATCH_LIMIT
      })
      if (!records) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const worktreeHosts = [
        ...new Set(records.dispatches.flatMap((row) => (row.worktree_id ? [row.worktree_id] : [])))
      ]
        .sort()
        .map((worktreeId) => ({
          worktreeId,
          scope: runtime.resolveOrchestrationReportWorktreeHostScope(worktreeId)
        }))
      return buildOrchestrationCostReport({
        records,
        usageSnapshots: runtime.getOrchestrationUsageSnapshots(),
        worktreeHosts,
        generatedAt: new Date().toISOString()
      })
    }
  })
]
