import { randomUUID } from 'node:crypto'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  AutomationRunFailureReport,
  AutomationRunOutputAttach,
  AutomationRunOutputRead,
  AutomationRunWarningReport
} from '../../../../shared/rpc-contract/automation-params'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  MAX_AUTOMATION_RUN_OUTPUTS,
  MAX_AUTOMATION_RUN_WARNINGS,
  type AutomationRunReport
} from '../../../../shared/automation-run-results'
import {
  NOT_IN_AUTOMATION_RUN_MESSAGE,
  REMOTE_TERMINAL_UNSUPPORTED_MESSAGE,
  resolveCallerAutomationRun,
  terminalCallerSession,
  type AutomationRunCallerSession
} from '../../../automations/automation-run-caller'
import {
  automationRunOutputsRoot,
  readAutomationRunOutputFile,
  removeAutomationRunOutputFile,
  writeAutomationRunOutputFile
} from '../../../automations/automation-run-output-files'
import { readLiveAgentSessionCaller } from '../orchestration-session-caller'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

const REFUSAL_COPY = {
  warning_limit: `This run already has ${MAX_AUTOMATION_RUN_WARNINGS} warnings. Reuse an existing --key for the same problem.`,
  output_limit: `This run already has ${MAX_AUTOMATION_RUN_OUTPUTS} attached files.`,
  unknown_warning: 'No warning with that --key was reported in this run.'
} as const

async function callerSession(
  method: string,
  context: RpcContext
): Promise<AutomationRunCallerSession> {
  // Session identity is same-host only; a paired client cannot speak for this host's agents.
  if (context.pairedDeviceId !== undefined) {
    throw new InvalidArgumentError(NOT_IN_AUTOMATION_RUN_MESSAGE)
  }
  const evidence = context.orchestrationCompatibilityEvidence
  if (evidence?.agentSessionId !== undefined && !evidence.host) {
    const record = await readLiveAgentSessionCaller(
      context.runtime,
      evidence.agentSessionId,
      method
    )
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new InvalidArgumentError(NOT_IN_AUTOMATION_RUN_MESSAGE)
    }
    const { submissions } = await host.journalSnapshot(record.sessionId)
    return {
      kind: 'chat',
      sessionIds: [record.sessionId, evidence.agentSessionId],
      submissions,
      store: host.deps.store
    }
  }
  if (evidence?.host) {
    throw new InvalidArgumentError(REMOTE_TERMINAL_UNSUPPORTED_MESSAGE)
  }
  const terminal = terminalCallerSession(context.runtime, evidence)
  if (!terminal) {
    throw new InvalidArgumentError(NOT_IN_AUTOMATION_RUN_MESSAGE)
  }
  return terminal
}

async function callerRun(method: string, context: RpcContext): Promise<AutomationRun> {
  const session = await callerSession(method, context)
  return resolveCallerAutomationRun(context.runtime.listAutomationRuns(), session, Date.now())
}

async function record(
  context: RpcContext,
  run: AutomationRun,
  report: AutomationRunReport
): Promise<{ runId: string }> {
  const outcome = await context.runtime.recordAutomationRunReport(run, report)
  if (!outcome.ok) {
    throw new InvalidArgumentError(REFUSAL_COPY[outcome.reason])
  }
  return { runId: run.id }
}

export const AUTOMATION_RUN_RESULT_METHODS = [
  defineMethod({
    name: 'automation.reportWarning',
    permission: 'workspace',
    params: AutomationRunWarningReport,
    handler: async (params, context) => {
      const run = await callerRun('automation.reportWarning', context)
      if (params.resolve) {
        return record(context, run, {
          kind: 'resolve-warning',
          key: params.key,
          resolution: params.message ?? null
        })
      }
      if (!params.message) {
        throw new InvalidArgumentError('Missing message')
      }
      return record(context, run, {
        kind: 'warning',
        key: params.key,
        message: params.message,
        impact: params.impact ?? null,
        evidence: params.evidence ?? null
      })
    }
  }),
  defineMethod({
    name: 'automation.reportFailure',
    permission: 'workspace',
    params: AutomationRunFailureReport,
    handler: async (params, context) => {
      const run = await callerRun('automation.reportFailure', context)
      return record(context, run, { kind: 'failure', message: params.message })
    }
  }),
  defineMethod({
    name: 'automation.attachOutput',
    permission: 'workspace',
    params: AutomationRunOutputAttach,
    handler: async (params, context) => {
      const run = await callerRun('automation.attachOutput', context)
      const bytes = Buffer.byteLength(params.content, 'utf8')
      const root = automationRunOutputsRoot()
      const output = {
        id: randomUUID(),
        title: params.title,
        format: params.format,
        bytes,
        attachedAt: Date.now()
      }
      // The file lands before the record so a listed output always has content.
      writeAutomationRunOutputFile(root, run, output, params.content)
      const outcome = await context.runtime.recordAutomationRunReport(run, {
        kind: 'output',
        output
      })
      if (!outcome.ok) {
        removeAutomationRunOutputFile(root, run, output)
        throw new InvalidArgumentError(REFUSAL_COPY[outcome.reason])
      }
      return { runId: run.id, outputId: output.id }
    }
  }),
  defineMethod({
    name: 'automation.readOutput',
    permission: 'workspace',
    params: AutomationRunOutputRead,
    handler: (params, { runtime }) => {
      const run = runtime.listAutomationRuns().find((entry) => entry.id === params.runId)
      const output = run?.outputs?.find((entry) => entry.id === params.outputId)
      const content =
        run && output ? readAutomationRunOutputFile(automationRunOutputsRoot(), run, output) : null
      if (!output || content === null) {
        throw new Error('This output is no longer available.')
      }
      return { output, content }
    }
  })
]
