import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

/** Correction 2 — the bounded typed operations that give the control plane real
 *  call sites: outcome admission with its candidate order, gate planning and
 *  recording, the validation lease, registry rows and certification evidence. */

function requireEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid ${flag}. Expected one of ${allowed.join(', ')}.`
    )
  }
  return value as T
}

export const ORCHESTRATION_CONTROL_PLANE_OPS_HANDLERS: Record<string, CommandHandler> = {
  'orchestration outcome-admit': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{
      outcome: { outcome_id: string; run_id: string }
      duplicate: boolean
    }>(client, flags, 'orchestration.outcomeAdmit', {
      from,
      run: getOptionalStringFlag(flags, 'run'),
      outcomeId: getRequiredStringFlag(flags, 'outcome-id'),
      title: getRequiredStringFlag(flags, 'title'),
      taskClassification: getOptionalStringFlag(flags, 'task-classification'),
      builderCandidates: getOptionalStringFlag(flags, 'builder-candidates'),
      reviewerCandidates: getOptionalStringFlag(flags, 'reviewer-candidates'),
      reviewCapabilities: getOptionalStringFlag(flags, 'review-capabilities'),
      allowUnknownQuota: flags.has('allow-unknown-quota') ? true : undefined,
      gatePolicy: getOptionalStringFlag(flags, 'gate-policy')
    })
    printResult(
      result,
      json,
      (value) =>
        `${value.duplicate ? 'Already admitted' : 'Admitted'} ${value.outcome.outcome_id} -> Run ${value.outcome.run_id}`
    )
  },

  'orchestration gates': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const record = getOptionalStringFlag(flags, 'record')
    const rawResult = getOptionalStringFlag(flags, 'result')
    const result = await callOrchestrationMutation<{
      scopeKey: string
      riskPolicy: string
      reuse: { gateId: string }[]
      rerun: { gateId: string; reason: string }[]
    }>(client, flags, 'orchestration.gatePlan', {
      from,
      run: getOptionalStringFlag(flags, 'run'),
      outcome: getOptionalStringFlag(flags, 'outcome'),
      sha: getRequiredStringFlag(flags, 'sha'),
      gates: getRequiredStringFlag(flags, 'gates'),
      files: getOptionalStringFlag(flags, 'files'),
      policyVersion: getOptionalStringFlag(flags, 'policy-version'),
      record,
      result: rawResult ? requireEnum(rawResult, ['PASS', 'FAIL'] as const, '--result') : undefined,
      riskPolicy: getOptionalStringFlag(flags, 'risk-policy')
    })
    printResult(result, json, (value) =>
      [
        `scope=${value.scopeKey} risk=${value.riskPolicy}`,
        `reuse: ${value.reuse.map((entry) => entry.gateId).join(', ') || '<none>'}`,
        ...value.rerun.map((entry) => `rerun ${entry.gateId}: ${entry.reason}`)
      ].join('\n')
    )
  },

  'orchestration validation-lease': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const action = requireEnum(
      getRequiredStringFlag(flags, 'action'),
      ['acquire', 'release', 'check'] as const,
      '--action'
    )
    const result = await callOrchestrationMutation<{
      scopeKey: string
      lease?: { leaseId: string; owner: string; expiresAt: string }
      duplicate?: boolean
      released?: boolean
      guard?: { allowed: boolean; reason?: string; remedies?: string[] }
    }>(client, flags, 'orchestration.validationLease', {
      from,
      run: getOptionalStringFlag(flags, 'run'),
      action,
      dispatch: getOptionalStringFlag(flags, 'dispatch'),
      leaseId: getOptionalStringFlag(flags, 'lease-id'),
      idempotencyKey: getOptionalStringFlag(flags, 'idempotency-key'),
      ttlMs: getOptionalPositiveIntegerValueFlag(flags, 'ttl-ms')
    })
    printResult(result, json, (value) => {
      if (value.guard) {
        return value.guard.allowed
          ? `scope=${value.scopeKey} mutation allowed`
          : `scope=${value.scopeKey} BLOCKED: ${value.guard.reason} (remedies: ${value.guard.remedies?.join(', ')})`
      }
      if (value.released !== undefined) {
        return `scope=${value.scopeKey} released=${value.released}`
      }
      return `scope=${value.scopeKey} lease=${value.lease?.leaseId} until ${value.lease?.expiresAt}${value.duplicate ? ' (duplicate)' : ''}`
    })
  },

  'orchestration phase-launch': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{
      runId: string
      launches: {
        phase_id: string
        task_id: string
        kind: string
        state: string
        dispatch_id: string | null
        attempts: number
        last_error: string | null
      }[]
    }>(client, flags, 'orchestration.phaseLaunch', {
      from,
      run: getOptionalStringFlag(flags, 'run'),
      // --inspect reads the ledger without forcing a launch pass.
      drive: flags.has('inspect') ? false : undefined
    })
    printResult(result, json, (value) =>
      value.launches.length === 0
        ? `No planned phases for run ${value.runId}`
        : value.launches
            .map(
              (launch) =>
                `${launch.kind} task=${launch.task_id} state=${launch.state} dispatch=${launch.dispatch_id ?? '<none>'} attempts=${launch.attempts}${launch.last_error ? ` error=${launch.last_error}` : ''}`
            )
            .join('\n')
    )
  },

  'orchestration route-upsert': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      route: { identity: { agent: string; model: string | null }; identityProof: string }
      drift: { code: string; reason: string }[]
    }>(client, flags, 'orchestration.routeUpsert', {
      agent: getRequiredStringFlag(flags, 'agent'),
      model: getOptionalStringFlag(flags, 'model'),
      reasoning: getOptionalStringFlag(flags, 'reasoning'),
      provider: getOptionalStringFlag(flags, 'provider'),
      harness: getOptionalStringFlag(flags, 'harness'),
      roles: getOptionalStringFlag(flags, 'roles'),
      capabilities: getOptionalStringFlag(flags, 'capabilities'),
      sessionModes: getOptionalStringFlag(flags, 'session-modes'),
      costClass: getOptionalStringFlag(flags, 'cost-class'),
      notes: getOptionalStringFlag(flags, 'notes')
    })
    printResult(result, json, (value) =>
      [
        `Registered ${value.route.identity.agent}/${value.route.identity.model ?? '<none>'} identityProof=${value.route.identityProof}`,
        ...value.drift.map((fault) => `DRIFT ${fault.code}: ${fault.reason}`)
      ].join('\n')
    )
  },

  'orchestration certify': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      evidence: { routeKey: string; kind: string; outcome: string; observedAt: string }
    }>(client, flags, 'orchestration.certify', {
      agent: getRequiredStringFlag(flags, 'agent'),
      model: getOptionalStringFlag(flags, 'model'),
      reasoning: getOptionalStringFlag(flags, 'reasoning'),
      role: requireEnum(
        getRequiredStringFlag(flags, 'role'),
        ['builder', 'reviewer'] as const,
        '--role'
      ),
      sessionMode: requireEnum(
        getRequiredStringFlag(flags, 'session-mode'),
        ['fresh', 'retained'] as const,
        '--session-mode'
      ),
      kind: getRequiredStringFlag(flags, 'kind'),
      outcome: requireEnum(
        getRequiredStringFlag(flags, 'outcome'),
        ['PASS', 'FAIL', 'UNSUPPORTED'] as const,
        '--outcome'
      ),
      dispatch: getOptionalStringFlag(flags, 'dispatch'),
      sha: getRequiredStringFlag(flags, 'sha'),
      detail: getOptionalStringFlag(flags, 'detail')
    })
    printResult(
      result,
      json,
      (value) =>
        `Recorded ${value.evidence.outcome} ${value.evidence.kind} for ${value.evidence.routeKey} at ${value.evidence.observedAt}`
    )
  },

  'orchestration routes': async ({ flags, client, json }) => {
    const result = await client.call<{
      routes: { identity: { agent: string; model: string | null } }[]
      drift: { routeKey: string; code: string }[]
      matrix: {
        routeKey: string
        identityProof: string
        cells: { role: string; sessionMode: string; state: string }[]
      }[]
    }>('orchestration.routes', { sha: getOptionalStringFlag(flags, 'sha') })
    printResult(result, json, (value) =>
      [
        ...value.matrix.map((row) =>
          [
            `${row.routeKey} identityProof=${row.identityProof}`,
            ...row.cells.map((cell) => `    ${cell.role}/${cell.sessionMode}: ${cell.state}`)
          ].join('\n')
        ),
        ...value.drift.map((fault) => `DRIFT ${fault.routeKey}: ${fault.code}`)
      ].join('\n')
    )
  }
}
