/* eslint-disable max-lines -- Why: this file centralizes the public Native Scryer Engine contract so catalog, pipeline, state-store, and adapters share one typed seam. */
import type { ScryModel } from './model'
import type { PendingChange } from './diff'

export type ScryerOperationId =
  | 'scryer.model.read'
  | 'scryer.model.search'
  | 'scryer.model.query'
  | 'scryer.rules.read'
  | 'scryer.codebase.read'
  | 'scryer.model.validate'
  | 'scryer.model.health'
  | 'scryer.plan.pending'
  | 'scryer.node.update'
  | 'scryer.link.add'
  | 'scryer.link.update'
  | 'scryer.link.delete'
  | 'scryer.node.set-subtree'
  | 'scryer.node.delete'
  | 'scryer.node.move'
  | 'scryer.responsibility.move'
  | 'scryer.group.set'
  | 'scryer.group.update'
  | 'scryer.group.delete'
  | 'scryer.person.add'
  | 'scryer.system.add'
  | 'scryer.container.add'
  | 'scryer.component.add'
  | 'scryer.group.add'
  | 'scryer.symbol.add'
  | 'scryer.source.update'
  | 'scryer.plan.fold'
  | 'scryer.model.set'
  | 'scryer.container.fill'
  | 'scryer.node.descope'
  | 'scryer.drift.get'
  | 'scryer.drift.flag'
  | 'scryer.drift.reconcile'

export type ScryerLayer = 'plan' | 'committed'
export type ScryerTransport = 'cli' | 'ipc' | 'ui' | 'agent' | 'system' | 'test'
export type ScryerCaller = 'human' | 'agent' | 'system' | 'test'
export type ScryerOperationRisk = 'normal' | 'destructive' | 'high'
export type ScryerOperationLockPolicy = 'none' | 'exclusive' | 'commit_if_writing'

export type ScryerOperationCapability =
  | 'read'
  | 'validate'
  | 'plan_diff'
  | 'plan_author'
  | 'source_author'
  | 'plan_fold'
  | 'model_generate'
  | 'model_correct'
  | 'drift_detect'
  | 'drift_record'
  | 'drift_reconcile'

export type ScryerOperationContext = {
  requestId?: string
  transport: ScryerTransport
  caller: ScryerCaller
  cwd: string
  projectRoot?: string
  workspaceRoot?: string
  sessionId?: string
  agentRunId?: string
  leaseToken?: string
  output?: {
    json?: boolean
    verbose?: boolean
  }
}

export type ScryerOperationErrorCode =
  | 'invalid_input'
  | 'invalid_context'
  | 'incompatible_model'
  | 'io_error'
  | 'lock_busy'
  | 'lease_required'
  | 'operation_not_found'
  | 'internal_error'
  | 'not_found'
  | 'illegal_link'
  | 'validation_failed'
  | 'agent_run_required'

export type ScryerOperationEntity =
  | 'project'
  | 'node'
  | 'link'
  | 'group'
  | 'responsibility'
  | 'property'
  | 'source_entry'
  | 'boundary'
  | 'rule_topic'
  | 'agent_run'

export type ScryerFieldError = {
  path: string
  message: string
  code?: string
}

export type ScryerOperationError = {
  code: ScryerOperationErrorCode
  message: string
  details?: Record<string, unknown>
  fieldErrors?: ScryerFieldError[]
  path?: string
  jsonPointer?: string
  retryable?: boolean
}

export type ScryerMaintenanceWriteTarget =
  | 'sync'
  | 'anchor_baseline'
  | 'committed_source_map_reanchor'
  | 'history'
  | 'baseline'

export type ScryerOperationWarningCode = 'maintenance_write_failed'

export type ScryerOperationWarning = {
  code: ScryerOperationWarningCode
  message: string
  target?: ScryerMaintenanceWriteTarget
  details?: Record<string, unknown>
}

export type ScryerOperationMeta = {
  projectRoot?: string
  warnings?: ScryerOperationWarning[]
  completionGate?: {
    complete: boolean
    pendingCount: number
    validationWarningCount: number
    validationErrorCount?: number
  }
}

export type ScryerOperationResult<TResult = unknown> =
  | {
      ok: true
      operationId: ScryerOperationId | string
      requestId: string
      result: TResult
      meta?: ScryerOperationMeta
    }
  | {
      ok: false
      operationId: ScryerOperationId | string
      requestId: string
      error: ScryerOperationError
      meta?: ScryerOperationMeta
    }

export type ScryerOperationAuthorizationPolicy = {
  transports: [ScryerTransport, ...ScryerTransport[]]
  project: {
    containment: 'workspace_required' | 'resolved_project_only'
    allowProjectOverride: boolean
  }
  agentRun: {
    required: boolean
    bindToContext: 'none' | 'agent_run_id_required'
  }
}

export type ScryerStateRead =
  | 'planned'
  | 'committed'
  | 'committed_if_available'
  | 'rules'
  | 'project_tree'
  | 'sync'
  | 'anchors'
  | 'build_edges'
  | 'history'

export type ScryerSemanticWrite = 'planned' | 'committed'
export type ScryerMaintenanceWriteMode = 'required' | 'best_effort'

export type ScryerMaintenanceWrite = {
  target: ScryerMaintenanceWriteTarget
  mode: ScryerMaintenanceWriteMode
}

export type ScryerSideEffect =
  | 'baseline_refresh'
  | 'history_append'
  | 'sync_state_write'
  | 'anchor_baseline_refresh'
  | 'seed_sync_if_absent'
  | 'write_anchor_baseline_if_absent'
  | 'silent_reanchor_committed_source_map'
  | 'build_edges_read'
  | 'completion_gate'

export type ScryerValidationPolicy =
  | 'structural_warnings'
  | 'coverage_warnings'
  | 'anchor_warnings'
  | 'write_guards'
  | 'link_legality'
  | 'hierarchy_integrity'
  | 'group_integrity'
  | 'source_mapping_integrity'
  | 'fold_postconditions'
  | 'generation_postconditions'

export type ScryerFlatOperationPolicy = {
  authorization: ScryerOperationAuthorizationPolicy
  lock: ScryerOperationLockPolicy
  lease: 'none' | 'write_if_active' | 'completion_gate'
  reads: ScryerStateRead[]
  semanticWrites: ScryerSemanticWrite[]
  maintenanceWrites: ScryerMaintenanceWrite[]
  validation: ScryerValidationPolicy[]
  sideEffects: ScryerSideEffect[]
}

export type ScryerOperationPolicyBranch = {
  when: {
    inputField: string
    equals: string
  }
  policy: ScryerFlatOperationPolicy
}

export type ScryerBranchedOperationPolicy = {
  discriminator: {
    inputField: string
    allowedValues: [string, ...string[]]
  }
  branches: [ScryerOperationPolicyBranch, ...ScryerOperationPolicyBranch[]]
}

export type ScryerOperationPolicy = ScryerFlatOperationPolicy | ScryerBranchedOperationPolicy

export type ScryerTransportMetadata = {
  cli?: {
    command: string
    acceptsJson: boolean
    aliases?: string[]
  }
  ipc?: {
    channel: string
    mode: 'invoke' | 'send'
  }
  ui?: {
    intent: string
    surface?: 'architecture' | 'agent_run'
  }
  agent?: {
    operationName: string
  }
  system?: {
    operationName: string
  }
  test?: {
    enabled: boolean
  }
}

export type ScryerUpstreamAnchor = {
  file?: string
  symbol: string
}

export type ResolvedScryerProject = {
  projectRoot: string
}

export type ScryerProjectRef = ResolvedScryerProject

export type ModelEditLease = {
  token: string
  owner?: 'agent' | 'human' | 'system'
  agentRunId?: string
  createdAt?: string
  expiresAt?: string
}

export type ScryerSyncState = {
  reconciledAt?: string
  commit?: string
}

export type ScryerHistoryEvent = Record<string, unknown>

export type ScryerStateChanges = {
  planned?: ScryModel
  committed?: ScryModel
  historyEvents?: ScryerHistoryEvent[]
  syncState?: ScryerSyncState
  baseline?: 'refresh' | 'none'
  anchorBaseline?: 'refresh' | 'none'
  committedSourceMapReanchor?: 'refresh' | 'none'
}

export type ScryerLoadedState = {
  committed?: ScryModel
  planned?: ScryModel
}

export type ScryerClock = {
  nowIso(): string
}

export type ScryerRequestIdFactory = {
  next(): string
}

export type ScryerValidationFindingCode =
  | 'duplicate_id'
  | 'missing_reference'
  | 'invalid_hierarchy'
  | 'invalid_external'
  | 'empty_responsibility'
  | 'description_too_long'
  | 'invalid_symbol_name'
  | 'empty_symbol'
  | 'illegal_link'
  | 'invalid_group'
  | 'unknown_source_map_target'
  | 'unknown_boundary_target'
  | 'disconnected_node'
  | 'coverage_gap'
  | 'coverage_overlap'
  | 'anchor_range_warning'
  | 'invalid_drift_marker_transition'

export type ScryerValidationFinding = {
  code: ScryerValidationFindingCode
  severity: 'warning' | 'error'
  message: string
  path?: string
  jsonPointer?: string
  details?: Record<string, unknown>
}

export type ScryerOperationOutcome<TResult> = {
  result: TResult
  changes?: ScryerStateChanges
  findings?: ScryerValidationFinding[]
  meta?: ScryerOperationMeta
}

export type ScryerExecutorFailure = {
  code: ScryerOperationErrorCode
  message: string
  details?: Record<string, unknown>
  fieldErrors?: ScryerFieldError[]
  path?: string
  jsonPointer?: string
  retryable?: boolean
}

export type ScryerExecutorResult<TResult> =
  | { ok: true; outcome: ScryerOperationOutcome<TResult> }
  | { ok: false; failure: ScryerExecutorFailure }

export type ScryerIdKind = 'node' | 'responsibility' | 'group' | 'link'

export type ScryerIdMinter = {
  node(): string
  responsibility(): string
  group(): string
  link(src: string, dst: string): string
  reserveExisting(id: string, kind?: ScryerIdKind): void
}

export type ScryerDiffService = {
  diffModels(from: ScryModel, to: ScryModel): PendingChange[]
}

export type ScryerFoldService = {
  foldTargets(args: { committed: ScryModel; planned: ScryModel; targets: ScryerFoldTarget[] }): {
    committed: ScryModel
    planned: ScryModel
    folded: ScryerFoldedItem[]
  }
}

export type ScryerSourceTarget =
  | { kind: 'responsibility'; responsibilityId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'raw'; key: string }

export type ScryerSourceRouteDecision = {
  targetKind: 'sourceMap' | 'boundary'
  key: string
  targetLayer: 'committed' | 'planned'
  clearOtherLayer: boolean
  reason: 'target_in_committed' | 'target_only_in_planned' | 'clear_requested'
  entry?: ScryModel['sourceMap'][string] | ScryModel['boundaries'][string]
}

export type ScryerSourceRouter = {
  routeSourceEntry(args: {
    target: ScryerSourceTarget
    entry: ScryModel['sourceMap'][string]
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision
  routeBoundaryEntry(args: {
    nodeId: string
    entry: ScryModel['boundaries'][string]
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision
  clearSourceTarget(args: {
    target: ScryerSourceTarget
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision
  applySourceRoutes(args: {
    committed: ScryModel
    planned: ScryModel
    decisions: ScryerSourceRouteDecision[]
  }): { committed: ScryModel; planned: ScryModel; routed: ScryerSourceRouteDecision[] }
}

export type ScryerValidatorSet = {
  validateModel(model: ScryModel): ScryerValidationFinding[]
  linkViolation(
    model: ScryModel,
    src: string,
    dst: string
  ): {
    reason: 'self_link' | 'ancestor_descendant' | 'same_level_reference' | 'duplicate_link'
  } | null
}

export type ScryerOperationServices = {
  ids: ScryerIdMinter
  validators: ScryerValidatorSet
  diff: ScryerDiffService
  fold: ScryerFoldService
  sourceRouter: ScryerSourceRouter
  clock: ScryerClock
}

export type ScryerOperationExecutor<TInput, TResult> = (args: {
  input: TInput
  context: ScryerOperationContext
  project: ResolvedScryerProject
  state: ScryerLoadedState
  services: ScryerOperationServices
}) => Promise<ScryerExecutorResult<TResult>> | ScryerExecutorResult<TResult>

export type ScryerOperationContract<TInput = unknown, TResult = unknown> = {
  id: ScryerOperationId
  capability: ScryerOperationCapability
  risk: ScryerOperationRisk
  inputSchema: {
    safeParse(value: unknown): { success: true; data: TInput } | { success: false; error: unknown }
  }
  successSchema: {
    safeParse(value: unknown): { success: true; data: TResult } | { success: false; error: unknown }
  }
  errors: Partial<
    Record<
      ScryerOperationErrorCode,
      {
        safeParse(
          value: unknown
        ): { success: true; data: unknown } | { success: false; error: unknown }
      }
    >
  >
  policy: ScryerOperationPolicy
  upstream: ScryerUpstreamAnchor[]
  transports: ScryerTransportMetadata
  execute: ScryerOperationExecutor<TInput, TResult>
}

export type ScryerCatalogValidationError = {
  operationId?: ScryerOperationId
  code:
    | 'duplicate_operation_id'
    | 'missing_schema'
    | 'missing_error_schema'
    | 'invalid_policy'
    | 'invalid_policy_branch'
    | 'invalid_transport_metadata'
    | 'missing_upstream_anchor'
    | 'test_transport_not_allowed'
  message: string
}

export type ScryerCatalogValidationResult = {
  ok: boolean
  errors: ScryerCatalogValidationError[]
}

export type ScryerOperationCatalog = {
  registerOperation<TInput, TResult>(contract: ScryerOperationContract<TInput, TResult>): void
  getOperationContract(operationId: string): ScryerOperationContract<unknown, unknown> | undefined
  listOperationContracts(): ScryerOperationContract<unknown, unknown>[]
  validateCatalog(options?: { allowTestTransport?: boolean }): ScryerCatalogValidationResult
}

export type ScryerErrorMapper = {
  mapExecutorFailure(args: {
    contract: ScryerOperationContract<unknown, unknown>
    failure: ScryerExecutorFailure
  }): ScryerOperationError
  mapPipelineFailure(args: {
    code: ScryerOperationErrorCode
    message: string
    details?: Record<string, unknown>
    fieldErrors?: ScryerFieldError[]
    path?: string
    jsonPointer?: string
    retryable?: boolean
  }): ScryerOperationError
  mapStateStoreFailure(args: {
    code: ScryerOperationErrorCode
    message: string
    details?: Record<string, unknown>
    retryable?: boolean
  }): ScryerOperationError
  mapUnexpectedException(args: {
    error: unknown
    contractOperationId?: string
  }): ScryerOperationError
  toOperationResult<TResult>(
    args:
      | {
          ok: true
          operationId: ScryerOperationId | string
          requestId: string
          result: TResult
          meta?: ScryerOperationMeta
        }
      | {
          ok: false
          operationId: ScryerOperationId | string
          requestId: string
          error: ScryerOperationError
          meta?: ScryerOperationMeta
        }
  ): ScryerOperationResult<TResult>
}

export type ScryerReadViewInput = {
  project?: string
  node?: string
  layer?: ScryerLayer
}

export type ScryerReadView = {
  layer: ScryerLayer
  model: ScryModel
  view?: unknown
  truncated?: boolean
  baselineRefreshed?: boolean
}

export type ScryerModelReadInput = ScryerReadViewInput
export type ScryerModelReadResult = ScryerReadView

export type ScryerModelValidateInput = {
  project?: string
}

export type ScryerModelValidateResult = {
  findings: ScryerValidationFinding[]
  validationWarningCount: number
  validationErrorCount: number
}

export type UpdateNodeItem = {
  node_id: string
  kind?: string
  name?: string
  description?: string
  technology?: string
  external?: boolean
  responsibilities?: ScryModel['nodes'][number]['responsibilities']
  properties?: ScryModel['nodes'][number]['properties']
  visual?: boolean
  appearance?: ScryModel['nodes'][number]['appearance']
  notes?: string
  parent_id?: string | null
}

export type ScryerNodeUpdateInput = {
  project?: string
  nodes: UpdateNodeItem[]
}

export type PendingSummary = {
  total: number
  byKind: Partial<Record<PendingChange['kind'], number>>
  byChange: Partial<Record<PendingChange['changes'][number]['type'], number>>
  toImplement: number
  toReimplement: number
  toMove: number
  toDelete: number
  toRepoint: number
}

export type ScryerNodeUpdateResult = {
  updatedCount: number
  findings?: ScryerValidationFinding[]
  pendingSummary?: PendingSummary
}

export type ScryerNodeDeleteInput = {
  project?: string
  node_ids: string[]
}

export type ScryerNodeDeleteResult = {
  deletedCount: number
  deletedLinkCount: number
  findings?: ScryerValidationFinding[]
  pendingSummary?: PendingSummary
}

export type AddLinkItem = {
  src: string
  dst: string
  label: string
  method?: string
}

export type ScryerLinkAddInput = {
  project?: string
  links: AddLinkItem[]
}

export type ScryerLinkAddResult = {
  addedIds: string[]
  findings?: ScryerValidationFinding[]
  pendingSummary?: PendingSummary
}

export type UpdateLinkItem = {
  link_id: string
  label?: string
  method?: string
}

export type ScryerLinkUpdateInput = {
  project?: string
  links: UpdateLinkItem[]
}

export type ScryerLinkUpdateResult = {
  updatedCount: number
  findings?: ScryerValidationFinding[]
  pendingSummary?: PendingSummary
}

export type ScryerLinkDeleteInput = {
  project?: string
  link_ids: string[]
}

export type ScryerLinkDeleteResult = {
  deletedCount: number
  missingIds?: string[]
  pendingSummary?: PendingSummary
}

export type ScryerPlanPendingInput = {
  project?: string
}

export type ScryerPlanPendingResult = {
  clean: boolean
  changes: PendingChange[]
  summary: PendingSummary
}

export type ScryerFoldTarget =
  | { kind: 'node'; node_id: string; includeDescendants?: boolean }
  | { kind: 'responsibility'; responsibility_id: string }
  | { kind: 'property'; node_id: string; label: string }
  | { kind: 'link'; link_id: string }
  | { kind: 'group'; group_id: string }

export type ScryerFoldedItem = {
  kind: 'node' | 'link' | 'responsibility' | 'property' | 'group'
  id: string
  ownerId?: string
  change?: string
}

export type ScryerPlanFoldInput = {
  project?: string
  mode?: 'manual' | 'agent_completion'
  node_id?: string
  responsibility_ids?: string[]
  property_labels?: string[]
  properties?: { node_id: string; label: string }[]
  link_ids?: string[]
  group_ids?: string[]
  include_descendants?: boolean
  all?: boolean
}

export type ScryerPlanFoldResult = {
  folded: ScryerFoldedItem[]
  remaining: PendingChange[]
  findings?: ScryerValidationFinding[]
}

export type CreateScryerEngineOptions = {
  catalog?: ScryerOperationCatalog
  stateStore?: unknown
  errorMapper?: ScryerErrorMapper
  clock?: ScryerClock
  requestIds?: ScryerRequestIdFactory
  test?: {
    allowTestTransport?: boolean
  }
}
