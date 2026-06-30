/* eslint-disable max-lines -- Why: the pipeline owns the full operation execution contract, including policy, validation, commit planning, and envelope mapping. */
import { isAbsolute, relative, resolve } from 'path'
import { errorDetailSchemas, operationWarningSchema } from './schemas'
import { ScryerEngineError } from './engine-error'
import { createScryerIdMinter } from './id-minter'
import { diffModels } from './diff'
import { createScryerFoldService } from './fold'
import { createScryerSourceRouter } from './source-router'
import { createScryerValidatorSet } from './validators'
import type {
  CreateScryerEngineOptions,
  ResolvedScryerProject,
  ScryerErrorMapper,
  ScryerExecutorFailure,
  ScryerFieldError,
  ScryerFlatOperationPolicy,
  ScryerOperationCatalog,
  ScryerOperationContext,
  ScryerOperationContract,
  ScryerOperationError,
  ScryerOperationErrorCode,
  ScryerOperationId,
  ScryerOperationMeta,
  ScryerOperationPolicy,
  ScryerOperationResult,
  ScryerOperationServices,
  ScryerSideEffect,
  ScryerStateChanges
} from './types'
import type {
  ScryerBestEffortCommitItem,
  ScryerPrimaryCommitItem,
  ScryerStateCommitPlan,
  ScryerStateStore
} from './state-store'

export type PipelineOptions = {
  catalog: ScryerOperationCatalog
  store: ScryerStateStore
  errorMapper: ScryerErrorMapper
  clock: NonNullable<CreateScryerEngineOptions['clock']>
  requestIds: NonNullable<CreateScryerEngineOptions['requestIds']>
  allowTestTransport: boolean
}

function fieldErrorsFromZod(error: unknown): ScryerFieldError[] {
  const issues =
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { issues?: unknown }).issues)
      ? (error as { issues: { path?: unknown[]; message?: string; code?: string }[] }).issues
      : []
  if (issues.length === 0) {
    return [{ path: 'input', message: 'Invalid input' }]
  }
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(String).join('.') || 'input',
    message: issue.message ?? 'Invalid input',
    ...(issue.code ? { code: issue.code } : {})
  }))
}

function failureResult(
  operationId: string,
  requestId: string,
  errorMapper: ScryerErrorMapper,
  args: {
    code: ScryerOperationErrorCode
    message: string
    details?: Record<string, unknown>
    fieldErrors?: ScryerFieldError[]
    path?: string
    jsonPointer?: string
    retryable?: boolean
    meta?: ScryerOperationMeta
  }
): ScryerOperationResult {
  return errorMapper.toOperationResult({
    ok: false,
    operationId,
    requestId,
    error: errorMapper.mapPipelineFailure(args),
    ...(args.meta ? { meta: args.meta } : {})
  })
}

function internalError(
  operationId: string,
  requestId: string,
  errorMapper: ScryerErrorMapper,
  reason:
    | 'success_schema_failed'
    | 'error_details_schema_failed'
    | 'undeclared_error_code'
    | 'policy_violation'
    | 'malformed_warning'
    | 'unknown_warning_code'
    | 'unexpected_exception',
  message: string
): ScryerOperationResult {
  return failureResult(operationId, requestId, errorMapper, {
    code: 'internal_error',
    message,
    details: { reason, contractOperationId: operationId }
  })
}

function validateContext(
  context: ScryerOperationContext,
  requestId: string
): ScryerExecutorFailure | null {
  if (!context.cwd) {
    return {
      code: 'invalid_context',
      message: 'Scryer operation context requires cwd',
      details: { reason: 'missing_workspace_root', field: 'cwd' }
    }
  }
  if (!context.transport) {
    return {
      code: 'invalid_context',
      message: 'Scryer operation context requires transport',
      details: { reason: 'unsupported_transport', field: 'transport' }
    }
  }
  if (!requestId) {
    return {
      code: 'invalid_context',
      message: 'Scryer operation context requires request id',
      details: { reason: 'missing_workspace_root', field: 'requestId' }
    }
  }
  return null
}

function resolvePolicy(
  policy: ScryerOperationPolicy,
  input: Record<string, unknown>
): ScryerFlatOperationPolicy | ScryerExecutorFailure {
  if (!('branches' in policy)) {
    return policy
  }
  const value = input[policy.discriminator.inputField]
  if (typeof value !== 'string') {
    return {
      code: 'invalid_input',
      message: `Missing policy discriminator '${policy.discriminator.inputField}'`,
      fieldErrors: [
        {
          path: policy.discriminator.inputField,
          message: 'Required policy discriminator'
        }
      ]
    }
  }
  const branch = policy.branches.find((candidate) => candidate.when.equals === value)
  if (!branch) {
    return {
      code: 'invalid_input',
      message: `Unsupported policy discriminator value '${value}'`,
      fieldErrors: [
        {
          path: policy.discriminator.inputField,
          message: `Expected one of ${policy.discriminator.allowedValues.join(', ')}`
        }
      ]
    }
  }
  return branch.policy
}

function resolveProject(
  input: Record<string, unknown>,
  context: ScryerOperationContext,
  policy: ScryerFlatOperationPolicy
): ResolvedScryerProject | ScryerExecutorFailure {
  const rawProject =
    typeof input.project === 'string' && policy.authorization.project.allowProjectOverride
      ? input.project
      : (context.projectRoot ?? context.cwd)
  const projectRoot = resolve(rawProject)
  if (policy.authorization.project.containment === 'workspace_required' && context.workspaceRoot) {
    const workspaceRoot = resolve(context.workspaceRoot)
    const rel = relative(workspaceRoot, projectRoot)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        code: 'invalid_context',
        message: 'Scryer project is outside the trusted workspace root',
        details: { reason: 'project_outside_workspace', field: 'project' }
      }
    }
  }
  return { projectRoot }
}

function transportFailure(
  context: ScryerOperationContext,
  policy: ScryerFlatOperationPolicy
): ScryerExecutorFailure | null {
  if (!policy.authorization.transports.includes(context.transport)) {
    return {
      code: 'invalid_context',
      message: `Transport '${context.transport}' cannot invoke this Scryer operation`,
      details: { reason: 'unsupported_transport', field: 'transport' }
    }
  }
  return null
}

async function leaseFailure(
  store: ScryerStateStore,
  project: ResolvedScryerProject,
  policy: ScryerFlatOperationPolicy,
  context: ScryerOperationContext,
  input: Record<string, unknown>
): Promise<ScryerExecutorFailure | null> {
  if (policy.authorization.agentRun.required && !context.agentRunId) {
    return {
      code: 'agent_run_required',
      message: 'Trusted Orca agent-run context is required',
      details: { mode: 'agent_completion', reason: 'missing_context' }
    }
  }
  if (policy.lease === 'none') {
    return null
  }
  const lease = await store.readActiveLease(project.projectRoot)
  if (!lease) {
    return policy.lease === 'completion_gate'
      ? {
          code: 'lease_required',
          message: 'Completion-gated Scryer fold requires an active matching lease',
          details: { policy: 'completion_gate' }
        }
      : null
  }
  if (context.leaseToken !== lease.token) {
    return {
      code: policy.lease === 'completion_gate' ? 'agent_run_required' : 'lease_required',
      message: 'A Scryer model edit lease is active; the matching lease token is required.',
      details:
        policy.lease === 'completion_gate'
          ? {
              mode: 'agent_completion',
              reason: 'lease_mismatch',
              agentRunId: context.agentRunId,
              leaseId: lease.token
            }
          : {
              policy: 'write_if_active',
              activeLeaseId: lease.token,
              activeOwner: context.transport
            },
      retryable: true
    }
  }
  if (
    policy.lease === 'completion_gate' &&
    typeof input.mode === 'string' &&
    input.mode === 'agent_completion' &&
    lease.agentRunId &&
    context.agentRunId !== lease.agentRunId
  ) {
    return {
      code: 'agent_run_required',
      message: 'Completion-gated fold lease is bound to a different agent run',
      details: {
        mode: 'agent_completion',
        reason: 'lease_mismatch',
        agentRunId: context.agentRunId,
        leaseId: lease.token
      }
    }
  }
  return null
}

function schemaForError(
  contract: ScryerOperationContract<unknown, unknown>,
  code: ScryerOperationErrorCode
) {
  return contract.errors[code] ?? errorDetailSchemas[code]
}

const COMMON_ERROR_CODES = new Set<ScryerOperationErrorCode>([
  'invalid_input',
  'invalid_context',
  'incompatible_model',
  'io_error',
  'lock_busy',
  'lease_required',
  'operation_not_found',
  'internal_error'
])

function validateErrorDetails(
  contract: ScryerOperationContract<unknown, unknown>,
  error: ScryerOperationError | ScryerExecutorFailure
): 'ok' | 'undeclared_error_code' | 'error_details_schema_failed' {
  const isCommon = COMMON_ERROR_CODES.has(error.code)
  if (!isCommon && !contract.errors[error.code]) {
    return 'undeclared_error_code'
  }
  const schema = schemaForError(contract, error.code)
  const result = schema.safeParse(error.details)
  return result.success ? 'ok' : 'error_details_schema_failed'
}

function maintenanceMode(
  policy: ScryerFlatOperationPolicy,
  target: string
): 'required' | 'best_effort' | null {
  return policy.maintenanceWrites.find((item) => item.target === target)?.mode ?? null
}

function pushMaintenance(
  primary: ScryerPrimaryCommitItem[],
  bestEffort: ScryerBestEffortCommitItem[],
  policy: ScryerFlatOperationPolicy,
  target: ScryerBestEffortCommitItem['target'],
  item: ScryerPrimaryCommitItem | ScryerBestEffortCommitItem,
  requiredSideEffect: ScryerSideEffect
): ScryerExecutorFailure | null {
  const mode = maintenanceMode(policy, target)
  if (!mode || !policy.sideEffects.includes(requiredSideEffect)) {
    return {
      code: 'internal_error',
      message: `Executor requested undeclared maintenance write ${target}`,
      details: { reason: 'policy_violation' }
    }
  }
  if (mode === 'required') {
    primary.push(item as ScryerPrimaryCommitItem)
  } else {
    bestEffort.push(item as ScryerBestEffortCommitItem)
  }
  return null
}

function buildCommitPlan(args: {
  operationId: ScryerOperationId
  requestId: string
  project: ResolvedScryerProject
  policy: ScryerFlatOperationPolicy
  changes?: ScryerStateChanges
}): ScryerStateCommitPlan | ScryerExecutorFailure {
  const primary: ScryerPrimaryCommitItem[] = []
  const bestEffort: ScryerBestEffortCommitItem[] = []
  const changes = args.changes
  if (!changes) {
    return {
      operationId: args.operationId,
      requestId: args.requestId,
      project: args.project,
      primary,
      bestEffort
    }
  }
  if (changes.planned) {
    if (!args.policy.semanticWrites.includes('planned')) {
      return {
        code: 'internal_error',
        message: 'Executor returned undeclared planned write',
        details: { reason: 'policy_violation' }
      }
    }
    primary.push({ target: 'planned', model: changes.planned })
  }
  if (changes.committed) {
    if (!args.policy.semanticWrites.includes('committed')) {
      return {
        code: 'internal_error',
        message: 'Executor returned undeclared committed write',
        details: { reason: 'policy_violation' }
      }
    }
    primary.push({ target: 'committed', model: changes.committed })
  }
  if (changes.historyEvents && changes.historyEvents.length > 0) {
    const failure = pushMaintenance(
      primary,
      bestEffort,
      args.policy,
      'history',
      { target: 'history', events: changes.historyEvents },
      'history_append'
    )
    if (failure) {
      return failure
    }
  }
  if (changes.syncState) {
    const effect = args.policy.sideEffects.includes('sync_state_write')
      ? 'sync_state_write'
      : 'seed_sync_if_absent'
    const failure = pushMaintenance(
      primary,
      bestEffort,
      args.policy,
      'sync',
      { target: 'sync', state: changes.syncState },
      effect
    )
    if (failure) {
      return failure
    }
  }
  if (changes.baseline === 'refresh') {
    const failure = pushMaintenance(
      primary,
      bestEffort,
      args.policy,
      'baseline',
      { target: 'baseline', action: 'refresh' },
      'baseline_refresh'
    )
    if (failure) {
      return failure
    }
  }
  if (changes.anchorBaseline === 'refresh') {
    const effect = args.policy.sideEffects.includes('anchor_baseline_refresh')
      ? 'anchor_baseline_refresh'
      : 'write_anchor_baseline_if_absent'
    const failure = pushMaintenance(
      primary,
      bestEffort,
      args.policy,
      'anchor_baseline',
      { target: 'anchor_baseline', action: 'refresh' },
      effect
    )
    if (failure) {
      return failure
    }
  }
  if (changes.committedSourceMapReanchor === 'refresh') {
    const failure = pushMaintenance(
      primary,
      bestEffort,
      args.policy,
      'committed_source_map_reanchor',
      { target: 'committed_source_map_reanchor', action: 'refresh' },
      'silent_reanchor_committed_source_map'
    )
    if (failure) {
      return failure
    }
  }
  return {
    operationId: args.operationId,
    requestId: args.requestId,
    project: args.project,
    primary,
    bestEffort
  }
}

function createServices(
  state: { committed?: unknown; planned?: unknown },
  clock: PipelineOptions['clock']
): ScryerOperationServices {
  return {
    ids: createScryerIdMinter({
      committed: state.committed as never,
      planned: state.planned as never
    }),
    validators: createScryerValidatorSet(),
    diff: { diffModels },
    fold: createScryerFoldService(),
    sourceRouter: createScryerSourceRouter(),
    clock
  }
}

async function runResolvedOperation(args: {
  operationId: ScryerOperationId
  contract: ScryerOperationContract<unknown, unknown>
  input: Record<string, unknown>
  context: ScryerOperationContext
  requestId: string
  policy: ScryerFlatOperationPolicy
  project: ResolvedScryerProject
  options: PipelineOptions
}): Promise<ScryerOperationResult> {
  const { contract, input, context, requestId, policy, project, options, operationId } = args
  const state = await options.store.loadDeclaredState(project, policy)
  let executorResult
  try {
    executorResult = await contract.execute({
      input,
      context,
      project,
      state,
      services: createServices(state, options.clock)
    })
  } catch (error) {
    return options.errorMapper.toOperationResult({
      ok: false,
      operationId,
      requestId,
      error: options.errorMapper.mapUnexpectedException({
        error,
        contractOperationId: operationId
      }),
      meta: { projectRoot: project.projectRoot }
    })
  }
  if (!executorResult.ok) {
    const validation = validateErrorDetails(contract, executorResult.failure)
    if (validation !== 'ok') {
      return internalError(
        operationId,
        requestId,
        options.errorMapper,
        validation,
        `Executor failure for ${operationId} violated its error contract`
      )
    }
    return options.errorMapper.toOperationResult({
      ok: false,
      operationId,
      requestId,
      error: options.errorMapper.mapExecutorFailure({ contract, failure: executorResult.failure }),
      meta: { projectRoot: project.projectRoot }
    })
  }
  const successCheck = contract.successSchema.safeParse(executorResult.outcome.result)
  if (!successCheck.success) {
    return internalError(
      operationId,
      requestId,
      options.errorMapper,
      'success_schema_failed',
      `Executor success result for ${operationId} violated its schema`
    )
  }
  const plan = buildCommitPlan({
    operationId,
    requestId,
    project,
    policy,
    changes: executorResult.outcome.changes
  })
  if ('code' in plan) {
    return internalError(
      operationId,
      requestId,
      options.errorMapper,
      'policy_violation',
      plan.message
    )
  }
  const commitResult =
    plan.primary.length > 0 || plan.bestEffort.length > 0
      ? await options.store.commit(plan)
      : { warnings: [] }
  for (const warning of commitResult.warnings) {
    const warningCheck = operationWarningSchema.safeParse(warning)
    if (!warningCheck.success) {
      return internalError(
        operationId,
        requestId,
        options.errorMapper,
        'malformed_warning',
        `State-store warning for ${operationId} violated warning schema`
      )
    }
  }
  return options.errorMapper.toOperationResult({
    ok: true,
    operationId,
    requestId,
    result: successCheck.data,
    meta: {
      projectRoot: project.projectRoot,
      ...(commitResult.warnings.length > 0 ? { warnings: commitResult.warnings } : {}),
      ...executorResult.outcome.meta
    }
  })
}

async function executeWithPolicyLock(args: Parameters<typeof runResolvedOperation>[0]) {
  if (args.policy.lock === 'exclusive') {
    return args.options.store.withWriteLock(args.project.projectRoot, () =>
      runResolvedOperation(args)
    )
  }
  if (args.policy.lock === 'commit_if_writing') {
    return runResolvedOperation({
      ...args,
      options: {
        ...args.options,
        store: {
          ...args.options.store,
          commit: (plan) =>
            plan.primary.length > 0 || plan.bestEffort.length > 0
              ? args.options.store.withWriteLock(args.project.projectRoot, () =>
                  args.options.store.commit(plan)
                )
              : args.options.store.commit(plan)
        }
      }
    })
  }
  return runResolvedOperation(args)
}

export async function executeCatalogOperation(
  operationId: string,
  rawInput: unknown,
  context: ScryerOperationContext,
  options: PipelineOptions
): Promise<ScryerOperationResult> {
  const requestId = context.requestId ?? options.requestIds.next()
  const contract = options.catalog.getOperationContract(operationId)
  if (!contract) {
    return failureResult(operationId, requestId, options.errorMapper, {
      code: 'operation_not_found',
      message: `Unknown Scryer operation '${operationId}'`,
      details: { operationId }
    })
  }
  const contextFailure = validateContext(context, requestId)
  if (contextFailure) {
    return failureResult(operationId, requestId, options.errorMapper, contextFailure)
  }
  const parsedInput = contract.inputSchema.safeParse(rawInput)
  if (!parsedInput.success) {
    return failureResult(operationId, requestId, options.errorMapper, {
      code: 'invalid_input',
      message: 'Scryer operation input failed schema validation',
      fieldErrors: fieldErrorsFromZod(parsedInput.error)
    })
  }
  const input =
    typeof parsedInput.data === 'object' && parsedInput.data !== null
      ? (parsedInput.data as Record<string, unknown>)
      : {}
  const resolvedPolicy = resolvePolicy(contract.policy, input)
  if ('code' in resolvedPolicy) {
    return failureResult(operationId, requestId, options.errorMapper, resolvedPolicy)
  }
  const transport = transportFailure(context, resolvedPolicy)
  if (transport) {
    return failureResult(operationId, requestId, options.errorMapper, transport)
  }
  const project = resolveProject(input, context, resolvedPolicy)
  if ('code' in project) {
    return failureResult(operationId, requestId, options.errorMapper, project)
  }
  try {
    const lease = await leaseFailure(options.store, project, resolvedPolicy, context, input)
    if (lease) {
      return failureResult(operationId, requestId, options.errorMapper, lease)
    }
    return await executeWithPolicyLock({
      operationId: contract.id,
      contract,
      input,
      context: { ...context, requestId },
      requestId,
      policy: resolvedPolicy,
      project,
      options
    })
  } catch (error) {
    if (error instanceof ScryerEngineError) {
      return failureResult(operationId, requestId, options.errorMapper, {
        code: error.code,
        message: error.message,
        details: error.details,
        fieldErrors: error.fieldErrors,
        retryable: error.retryable
      })
    }
    return options.errorMapper.toOperationResult({
      ok: false,
      operationId,
      requestId,
      error: options.errorMapper.mapUnexpectedException({
        error,
        contractOperationId: contract.id
      })
    })
  }
}

export const executeScryerOperation = executeCatalogOperation
