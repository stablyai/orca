import { z } from 'zod'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  automationListSchema,
  automationSchema,
  runSchema,
  runsPageSchema,
  projectInventorySchema,
  setupInventorySchema,
  sshInventorySchema
} from './automation-reply-schema'

export const automationListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-list',
    method: 'automation.list',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('owned-automations', automationListSchema)
  })
)
export const automationShowRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-show',
    method: 'automation.show',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('automation', z.object({ automation: automationSchema }))
  })
)
export const automationCreateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-create',
    method: 'automation.create',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('automation', z.object({ automation: automationSchema }))
  })
)
export const automationUpdateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-update',
    method: 'automation.update',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('automation', z.object({ automation: automationSchema }))
  })
)
export const automationDeleteWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-delete',
    method: 'automation.delete',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('removed', z.object({ removed: z.boolean(), id: z.string() }))
  })
)
export const automationRunWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-run-now',
    method: 'automation.runNow',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('run', z.object({ run: runSchema }))
  })
)
export const automationRunsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.mobile-runs',
    method: 'automation.runs',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('runs-page', runsPageSchema)
  })
)
export const automationProjectsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project.mobile-automation-inventory',
    method: 'project.list',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('projects', projectInventorySchema)
  })
)
export const automationSetupsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectHostSetup.mobile-automation-inventory',
    method: 'projectHostSetup.list',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('setups', setupInventorySchema)
  })
)
export const automationSshTargetsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.mobile-automation-destinations',
    method: 'ssh.listTargetSummaries',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ssh-targets', sshInventorySchema)
  })
)

export const automationWorkspacesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.mobile-automation-inventory',
    method: 'worktree.list',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'managed-workspaces',
      z.object({
        worktrees: z.array(z.unknown()),
        totalCount: z.number(),
        truncated: z.boolean(),
        hostScope: z.object({ hostIds: z.array(z.string()), omittedHostIds: z.array(z.string()) })
      })
    )
  })
)

export const automationAgentSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.mobile-automation-agent-policy',
    method: 'settings.getAgentLaunch',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'agent-policy',
      z.object({
        settings: z.object({
          defaultTuiAgent: z
            .custom<TuiAgent | 'blank'>((value) => isTuiAgent(value) || value === 'blank')
            .nullish(),
          disabledTuiAgents: z.array(z.string()).optional()
        })
      })
    )
  })
)
