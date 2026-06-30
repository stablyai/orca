/* eslint-disable max-lines -- Why: the catalog is the executable 33-operation contract matrix; keeping policy rows together makes coverage and parity review auditable. */
import { errorDetailSchemas, operationSchemas } from './schemas'
import { modelReadOperation } from './operations/model-read'
import { modelValidateOperation } from './operations/model-validate'
import { nodeDeleteOperation } from './operations/node-delete'
import { nodeUpdateOperation } from './operations/node-update'
import { linkAddOperation } from './operations/link-add'
import { linkDeleteOperation } from './operations/link-delete'
import { linkUpdateOperation } from './operations/link-update'
import { planPendingOperation } from './operations/plan-pending'
import { planFoldOperation } from './operations/plan-fold'
import {
  componentAddOperation,
  containerAddOperation,
  driftGetOperation,
  driftReconcileOperation,
  groupAddOperation,
  groupDeleteOperation,
  groupSetOperation,
  groupUpdateOperation,
  modelSetOperation,
  personAddOperation,
  sourceUpdateOperation,
  symbolAddOperation,
  systemAddOperation
} from './operations/structural'
import { failure } from './operations/helpers'
import type {
  ScryerCatalogValidationError,
  ScryerCatalogValidationResult,
  ScryerFlatOperationPolicy,
  ScryerMaintenanceWriteTarget,
  ScryerOperationCapability,
  ScryerOperationCatalog,
  ScryerOperationContract,
  ScryerOperationErrorCode,
  ScryerOperationExecutor,
  ScryerOperationId,
  ScryerOperationPolicy,
  ScryerOperationRisk,
  ScryerSideEffect,
  ScryerStateRead,
  ScryerTransport,
  ScryerTransportMetadata,
  ScryerUpstreamAnchor
} from './types'

export const ALL_SCRYER_OPERATION_IDS: ScryerOperationId[] = [
  'scryer.model.read',
  'scryer.model.search',
  'scryer.model.query',
  'scryer.rules.read',
  'scryer.codebase.read',
  'scryer.model.validate',
  'scryer.model.health',
  'scryer.plan.pending',
  'scryer.node.update',
  'scryer.link.add',
  'scryer.link.update',
  'scryer.link.delete',
  'scryer.node.set-subtree',
  'scryer.node.delete',
  'scryer.node.move',
  'scryer.responsibility.move',
  'scryer.group.set',
  'scryer.group.update',
  'scryer.group.delete',
  'scryer.person.add',
  'scryer.system.add',
  'scryer.container.add',
  'scryer.component.add',
  'scryer.group.add',
  'scryer.symbol.add',
  'scryer.source.update',
  'scryer.plan.fold',
  'scryer.model.set',
  'scryer.container.fill',
  'scryer.node.descope',
  'scryer.drift.get',
  'scryer.drift.flag',
  'scryer.drift.reconcile'
]

const PRODUCT_TRANSPORTS: [ScryerTransport, ...ScryerTransport[]] = [
  'cli',
  'ipc',
  'ui',
  'agent',
  'system'
]

type PolicyArgs = {
  transports?: [ScryerTransport, ...ScryerTransport[]]
  lock: ScryerFlatOperationPolicy['lock']
  lease: ScryerFlatOperationPolicy['lease']
  reads: ScryerStateRead[]
  semanticWrites?: ScryerFlatOperationPolicy['semanticWrites']
  maintenanceWrites?: ScryerFlatOperationPolicy['maintenanceWrites']
  validation?: ScryerFlatOperationPolicy['validation']
  sideEffects?: ScryerSideEffect[]
  agentRunRequired?: boolean
}

type Row = {
  id: ScryerOperationId
  capability: ScryerOperationCapability
  risk: ScryerOperationRisk
  policy: ScryerOperationPolicy
  errors?: ScryerOperationErrorCode[]
  upstream: ScryerUpstreamAnchor[]
  execute?: ScryerOperationExecutor<unknown, unknown>
}

function operationErrors(...codes: ScryerOperationErrorCode[]): ScryerOperationErrorCode[] {
  return codes
}

function flatPolicy(args: PolicyArgs): ScryerFlatOperationPolicy {
  return {
    authorization: {
      transports: args.transports ?? PRODUCT_TRANSPORTS,
      project: {
        containment: 'workspace_required',
        allowProjectOverride: true
      },
      agentRun: {
        required: args.agentRunRequired ?? false,
        bindToContext: args.agentRunRequired ? 'agent_run_id_required' : 'none'
      }
    },
    lock: args.lock,
    lease: args.lease,
    reads: args.reads,
    semanticWrites: args.semanticWrites ?? [],
    maintenanceWrites: args.maintenanceWrites ?? [],
    validation: args.validation ?? [],
    sideEffects: args.sideEffects ?? []
  }
}

function planFoldPolicy(): ScryerOperationPolicy {
  const base = {
    lock: 'exclusive',
    reads: ['committed', 'planned'],
    semanticWrites: ['committed', 'planned'],
    maintenanceWrites: [
      { target: 'baseline', mode: 'best_effort' },
      { target: 'history', mode: 'best_effort' }
    ],
    validation: [
      'fold_postconditions',
      'link_legality',
      'group_integrity',
      'source_mapping_integrity'
    ],
    sideEffects: ['baseline_refresh', 'history_append']
  } satisfies Omit<PolicyArgs, 'lease'>
  return {
    discriminator: { inputField: 'mode', allowedValues: ['manual', 'agent_completion'] },
    branches: [
      {
        when: { inputField: 'mode', equals: 'manual' },
        policy: flatPolicy({ ...base, lease: 'write_if_active' })
      },
      {
        when: { inputField: 'mode', equals: 'agent_completion' },
        policy: flatPolicy({
          ...base,
          lease: 'completion_gate',
          agentRunRequired: true,
          sideEffects: ['baseline_refresh', 'history_append', 'completion_gate']
        })
      }
    ]
  }
}

function unimplemented(operationId: ScryerOperationId): ScryerOperationExecutor<unknown, unknown> {
  return () =>
    failure('internal_error', `${operationId} is registered but not implemented in this slice`, {
      reason: 'unexpected_exception',
      contractOperationId: operationId
    })
}

function metadataFor(
  id: ScryerOperationId,
  policy: ScryerOperationPolicy
): ScryerTransportMetadata {
  const transports =
    'branches' in policy
      ? policy.branches[0].policy.authorization.transports
      : policy.authorization.transports
  return {
    ...(transports.includes('cli')
      ? {
          cli: {
            command: id.replace(/^scryer\./, 'scryer ').replaceAll('.', ' '),
            acceptsJson: true
          }
        }
      : {}),
    ...(transports.includes('ipc')
      ? { ipc: { channel: 'architecture:executeScryerOperation', mode: 'invoke' as const } }
      : {}),
    ...(transports.includes('ui') ? { ui: { intent: id, surface: 'architecture' as const } } : {}),
    ...(transports.includes('agent') ? { agent: { operationName: id } } : {}),
    ...(transports.includes('system') ? { system: { operationName: id } } : {}),
    ...(transports.includes('test') ? { test: { enabled: true } } : {})
  }
}

const ADD_OPERATIONS = {
  person: personAddOperation as ScryerOperationExecutor<unknown, unknown>,
  system: systemAddOperation as ScryerOperationExecutor<unknown, unknown>,
  container: containerAddOperation as ScryerOperationExecutor<unknown, unknown>,
  component: componentAddOperation as ScryerOperationExecutor<unknown, unknown>,
  group: groupAddOperation as ScryerOperationExecutor<unknown, unknown>,
  symbol: symbolAddOperation as ScryerOperationExecutor<unknown, unknown>
} satisfies Record<
  'person' | 'system' | 'container' | 'component' | 'group' | 'symbol',
  ScryerOperationExecutor<unknown, unknown>
>

const ROWS: Row[] = [
  {
    id: 'scryer.model.read',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'commit_if_writing',
      lease: 'none',
      reads: ['planned', 'committed_if_available'],
      maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }],
      sideEffects: ['baseline_refresh']
    }),
    errors: ['not_found'],
    upstream: [{ symbol: 'read.rs::read_model' }, { symbol: 'ReadModelRequest' }],
    execute: modelReadOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.model.search',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({ lock: 'none', lease: 'none', reads: ['planned', 'committed'] }),
    upstream: [{ symbol: 'read.rs::search_model' }, { symbol: 'SearchModelRequest' }]
  },
  {
    id: 'scryer.model.query',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({ lock: 'none', lease: 'none', reads: ['planned', 'committed'] }),
    errors: ['not_found'],
    upstream: [{ symbol: 'read.rs::query_model' }, { symbol: 'QueryModelRequest' }]
  },
  {
    id: 'scryer.rules.read',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({ lock: 'none', lease: 'none', reads: ['rules'] }),
    upstream: [{ symbol: 'read.rs::get_rules' }, { symbol: 'GetRulesRequest' }]
  },
  {
    id: 'scryer.codebase.read',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({ lock: 'none', lease: 'none', reads: ['project_tree'] }),
    upstream: [{ symbol: 'read.rs::read_codebase' }, { symbol: 'ReadCodebaseRequest' }]
  },
  {
    id: 'scryer.model.validate',
    capability: 'validate',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'none',
      lease: 'none',
      reads: ['committed'],
      validation: ['structural_warnings', 'coverage_warnings', 'anchor_warnings']
    }),
    upstream: [{ symbol: 'read.rs::validate_model' }, { symbol: 'validate.rs' }],
    execute: modelValidateOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.model.health',
    capability: 'read',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'commit_if_writing',
      lease: 'none',
      reads: ['committed', 'sync', 'anchors', 'project_tree', 'build_edges'],
      maintenanceWrites: [
        { target: 'sync', mode: 'best_effort' },
        { target: 'anchor_baseline', mode: 'best_effort' },
        { target: 'committed_source_map_reanchor', mode: 'best_effort' }
      ],
      sideEffects: [
        'seed_sync_if_absent',
        'write_anchor_baseline_if_absent',
        'silent_reanchor_committed_source_map',
        'build_edges_read'
      ]
    }),
    errors: ['not_found'],
    upstream: [
      { symbol: 'read.rs::get_health' },
      { symbol: 'health.rs' },
      { symbol: 'build_edges.rs' }
    ]
  },
  {
    id: 'scryer.plan.pending',
    capability: 'plan_diff',
    risk: 'normal',
    policy: flatPolicy({ lock: 'none', lease: 'none', reads: ['committed', 'planned'] }),
    upstream: [{ symbol: 'read.rs::get_pending' }, { symbol: 'diff.rs' }],
    execute: planPendingOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.node.update',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['committed_if_available', 'planned'],
      semanticWrites: ['planned'],
      validation: ['write_guards', 'hierarchy_integrity']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'nodes.rs::update_nodes' }, { symbol: 'UpdateNodeRequest' }],
    execute: nodeUpdateOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.link.add',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['committed_if_available', 'planned'],
      semanticWrites: ['planned'],
      validation: ['link_legality', 'write_guards']
    }),
    errors: ['not_found', 'illegal_link', 'validation_failed'],
    upstream: [{ symbol: 'links.rs::add_links' }, { symbol: 'AddLinkRequest' }],
    execute: linkAddOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.link.update',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['link_legality', 'write_guards']
    }),
    errors: ['not_found'],
    upstream: [{ symbol: 'links.rs::update_links' }, { symbol: 'UpdateLinkRequest' }],
    execute: linkUpdateOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.link.delete',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['committed_if_available', 'planned'],
      semanticWrites: ['planned'],
      validation: ['write_guards']
    }),
    upstream: [{ symbol: 'links.rs::delete_links' }, { symbol: 'DeleteLinkRequest' }],
    execute: linkDeleteOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.node.set-subtree',
    capability: 'plan_author',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['write_guards', 'hierarchy_integrity']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'nodes.rs::set_node' }, { symbol: 'SetNodeRequest' }]
  },
  {
    id: 'scryer.node.delete',
    capability: 'plan_author',
    risk: 'destructive',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['write_guards']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'nodes.rs::delete_nodes' }, { symbol: 'DeleteNodeRequest' }],
    execute: nodeDeleteOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.node.move',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      maintenanceWrites: [{ target: 'history', mode: 'best_effort' }],
      validation: ['hierarchy_integrity', 'write_guards'],
      sideEffects: ['history_append']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'nodes.rs::move_nodes' }, { symbol: 'MoveNodesRequest' }]
  },
  {
    id: 'scryer.responsibility.move',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      maintenanceWrites: [{ target: 'history', mode: 'best_effort' }],
      validation: ['write_guards'],
      sideEffects: ['history_append']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [
      { symbol: 'nodes.rs::move_responsibilities' },
      { symbol: 'MoveResponsibilitiesRequest' }
    ]
  },
  {
    id: 'scryer.group.set',
    capability: 'plan_author',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['group_integrity', 'write_guards']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'misc.rs::set_groups' }, { symbol: 'SetGroupsRequest' }],
    execute: groupSetOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.group.update',
    capability: 'plan_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['group_integrity', 'write_guards']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'misc.rs::update_group' }, { symbol: 'UpdateGroupRequest' }],
    execute: groupUpdateOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.group.delete',
    capability: 'plan_author',
    risk: 'destructive',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['group_integrity', 'write_guards']
    }),
    errors: ['not_found'],
    upstream: [{ symbol: 'misc.rs::delete_group' }, { symbol: 'DeleteGroupRequest' }],
    execute: groupDeleteOperation as ScryerOperationExecutor<unknown, unknown>
  },
  ...(['person', 'system', 'container', 'component', 'group', 'symbol'] as const).map((kind) => ({
    id: `scryer.${kind}.add` as ScryerOperationId,
    capability: 'plan_author' as const,
    risk: 'normal' as const,
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      validation: ['hierarchy_integrity', 'group_integrity', 'source_mapping_integrity']
    }),
    errors:
      kind === 'person' || kind === 'system'
        ? operationErrors('validation_failed')
        : operationErrors('not_found', 'validation_failed'),
    upstream: [
      { symbol: `intent.rs::add_${kind}` },
      { symbol: `Add${kind[0].toUpperCase()}${kind.slice(1)}Request` }
    ],
    execute: ADD_OPERATIONS[kind] as ScryerOperationExecutor<unknown, unknown>
  })),
  {
    id: 'scryer.source.update',
    capability: 'source_author',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['committed_if_available', 'planned'],
      semanticWrites: ['planned', 'committed'],
      validation: ['source_mapping_integrity', 'write_guards']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'misc.rs::update_source_map' }, { symbol: 'UpdateSourceMapRequest' }],
    execute: sourceUpdateOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.plan.fold',
    capability: 'plan_fold',
    risk: 'high',
    policy: planFoldPolicy(),
    errors: ['not_found', 'validation_failed', 'agent_run_required'],
    upstream: [
      { symbol: 'nodes.rs::mark_implemented' },
      { symbol: 'MarkImplementedRequest' },
      { symbol: 'diff.rs' }
    ],
    execute: planFoldOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.model.set',
    capability: 'model_generate',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'none',
      reads: [],
      semanticWrites: ['committed', 'planned'],
      maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }],
      validation: ['structural_warnings', 'write_guards'],
      sideEffects: ['baseline_refresh']
    }),
    errors: ['validation_failed'],
    upstream: [{ symbol: 'nodes.rs::set_model' }, { symbol: 'SetModelRequest' }],
    execute: modelSetOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.container.fill',
    capability: 'model_generate',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'none',
      reads: ['committed', 'planned', 'build_edges'],
      semanticWrites: ['committed', 'planned'],
      maintenanceWrites: [{ target: 'history', mode: 'best_effort' }],
      validation: [
        'generation_postconditions',
        'link_legality',
        'group_integrity',
        'source_mapping_integrity'
      ],
      sideEffects: ['build_edges_read', 'history_append']
    }),
    errors: ['not_found', 'validation_failed', 'illegal_link'],
    upstream: [
      { symbol: 'generation.rs::fill_container' },
      { symbol: 'CommitContainerModelRequest' },
      { symbol: 'build_edges.rs' }
    ]
  },
  {
    id: 'scryer.node.descope',
    capability: 'model_correct',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['committed', 'planned'],
      semanticWrites: ['committed', 'planned'],
      maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }],
      validation: ['hierarchy_integrity', 'write_guards'],
      sideEffects: ['baseline_refresh']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [{ symbol: 'nodes.rs::descope' }, { symbol: 'DescopeRequest' }]
  },
  {
    id: 'scryer.drift.get',
    capability: 'drift_detect',
    risk: 'normal',
    policy: flatPolicy({
      lock: 'commit_if_writing',
      lease: 'none',
      reads: ['committed_if_available', 'sync', 'anchors', 'project_tree'],
      maintenanceWrites: [
        { target: 'sync', mode: 'best_effort' },
        { target: 'anchor_baseline', mode: 'best_effort' }
      ],
      sideEffects: ['seed_sync_if_absent', 'write_anchor_baseline_if_absent']
    }),
    upstream: [{ symbol: 'read.rs::get_drift' }, { symbol: 'drift.rs' }],
    execute: driftGetOperation as ScryerOperationExecutor<unknown, unknown>
  },
  {
    id: 'scryer.drift.flag',
    capability: 'drift_record',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'write_if_active',
      reads: ['planned'],
      semanticWrites: ['planned'],
      maintenanceWrites: [{ target: 'history', mode: 'best_effort' }],
      validation: ['hierarchy_integrity', 'source_mapping_integrity', 'write_guards'],
      sideEffects: ['history_append']
    }),
    errors: ['not_found', 'validation_failed'],
    upstream: [
      { symbol: 'intent.rs::flag_drift' },
      { symbol: 'FlagDriftRequest' },
      { symbol: 'drift.rs' }
    ]
  },
  {
    id: 'scryer.drift.reconcile',
    capability: 'drift_reconcile',
    risk: 'high',
    policy: flatPolicy({
      lock: 'exclusive',
      lease: 'none',
      reads: ['committed', 'sync', 'anchors', 'project_tree'],
      maintenanceWrites: [
        { target: 'sync', mode: 'required' },
        { target: 'anchor_baseline', mode: 'required' }
      ],
      sideEffects: ['sync_state_write', 'anchor_baseline_refresh']
    }),
    upstream: [
      { symbol: 'intent.rs::reconcile_drift' },
      { symbol: 'ReconcileDriftRequest' },
      { symbol: 'drift.rs' }
    ],
    execute: driftReconcileOperation as ScryerOperationExecutor<unknown, unknown>
  }
]

function sideEffectRequirements(effect: ScryerSideEffect): {
  maintenance?: ScryerMaintenanceWriteTarget
  read?: ScryerStateRead
  lease?: ScryerFlatOperationPolicy['lease']
} {
  switch (effect) {
    case 'history_append':
      return { maintenance: 'history' }
    case 'baseline_refresh':
      return { maintenance: 'baseline' }
    case 'sync_state_write':
    case 'seed_sync_if_absent':
      return { maintenance: 'sync' }
    case 'anchor_baseline_refresh':
    case 'write_anchor_baseline_if_absent':
      return { maintenance: 'anchor_baseline' }
    case 'silent_reanchor_committed_source_map':
      return { maintenance: 'committed_source_map_reanchor' }
    case 'build_edges_read':
      return { read: 'build_edges' }
    case 'completion_gate':
      return { lease: 'completion_gate' }
  }
}

function flatPolicies(policy: ScryerOperationPolicy): ScryerFlatOperationPolicy[] {
  return 'branches' in policy ? policy.branches.map((branch) => branch.policy) : [policy]
}

function metadataKeys(metadata: ScryerTransportMetadata): ScryerTransport[] {
  return Object.keys(metadata) as ScryerTransport[]
}

export function createScryerOperationCatalog(): ScryerOperationCatalog {
  const contracts: ScryerOperationContract<unknown, unknown>[] = []
  return {
    registerOperation(contract) {
      contracts.push(contract as ScryerOperationContract<unknown, unknown>)
    },
    getOperationContract(operationId) {
      return contracts.find((contract) => contract.id === operationId)
    },
    listOperationContracts() {
      return [...contracts]
    },
    validateCatalog(options = {}) {
      const errors: ScryerCatalogValidationError[] = []
      const seen = new Set<string>()
      for (const contract of contracts) {
        if (seen.has(contract.id)) {
          errors.push({
            operationId: contract.id,
            code: 'duplicate_operation_id',
            message: `Duplicate Scryer operation id ${contract.id}`
          })
        }
        seen.add(contract.id)
        if (!contract.inputSchema || !contract.successSchema) {
          errors.push({
            operationId: contract.id,
            code: 'missing_schema',
            message: `${contract.id} must declare input and success schemas`
          })
        }
        for (const [code, schema] of Object.entries(contract.errors)) {
          if (!schema || !errorDetailSchemas[code as ScryerOperationErrorCode]) {
            errors.push({
              operationId: contract.id,
              code: 'missing_error_schema',
              message: `${contract.id} declares ${code} without a detail schema`
            })
          }
        }
        if (contract.upstream.length === 0) {
          errors.push({
            operationId: contract.id,
            code: 'missing_upstream_anchor',
            message: `${contract.id} must reference upstream behavior anchors`
          })
        }
        if ('branches' in contract.policy) {
          const values = contract.policy.discriminator.allowedValues
          const branches = contract.policy.branches.map((branch) => branch.when.equals)
          for (const value of values) {
            if (branches.filter((branch) => branch === value).length !== 1) {
              errors.push({
                operationId: contract.id,
                code: 'invalid_policy_branch',
                message: `${contract.id} must have exactly one branch for ${value}`
              })
            }
          }
        }
        for (const policy of flatPolicies(contract.policy)) {
          for (const effect of policy.sideEffects) {
            const requirement = sideEffectRequirements(effect)
            if (
              requirement.maintenance &&
              !policy.maintenanceWrites.some((item) => item.target === requirement.maintenance)
            ) {
              errors.push({
                operationId: contract.id,
                code: 'invalid_policy',
                message: `${contract.id} side effect ${effect} requires ${requirement.maintenance}`
              })
            }
            if (requirement.read && !policy.reads.includes(requirement.read)) {
              errors.push({
                operationId: contract.id,
                code: 'invalid_policy',
                message: `${contract.id} side effect ${effect} requires read ${requirement.read}`
              })
            }
            if (
              requirement.lease &&
              policy.lease !== requirement.lease &&
              contract.capability !== 'plan_fold'
            ) {
              errors.push({
                operationId: contract.id,
                code: 'invalid_policy',
                message: `${contract.id} side effect ${effect} requires ${requirement.lease}`
              })
            }
          }
          if (
            contract.risk === 'high' &&
            (policy.semanticWrites.length > 0 ||
              policy.maintenanceWrites.some((item) => item.mode === 'required')) &&
            policy.lock !== 'exclusive'
          ) {
            errors.push({
              operationId: contract.id,
              code: 'invalid_policy',
              message: `${contract.id} high-risk writes require an exclusive lock`
            })
          }
          for (const key of metadataKeys(contract.transports)) {
            if (!policy.authorization.transports.includes(key)) {
              errors.push({
                operationId: contract.id,
                code: 'invalid_transport_metadata',
                message: `${contract.id} metadata exposes ${key} outside authorization policy`
              })
            }
          }
        }
        if (!options.allowTestTransport && contract.transports.test) {
          errors.push({
            operationId: contract.id,
            code: 'test_transport_not_allowed',
            message: `${contract.id} exposes test transport in a production catalog`
          })
        }
      }
      for (const operationId of ALL_SCRYER_OPERATION_IDS) {
        if (!seen.has(operationId)) {
          errors.push({
            operationId,
            code: 'missing_schema',
            message: `${operationId} is missing from the catalog`
          })
        }
      }
      return { ok: errors.length === 0, errors } satisfies ScryerCatalogValidationResult
    }
  }
}

export function createDefaultScryerOperationCatalog(): ScryerOperationCatalog {
  const catalog = createScryerOperationCatalog()
  for (const row of ROWS) {
    const schemas = operationSchemas[row.id]
    const contract: ScryerOperationContract<unknown, unknown> = {
      id: row.id,
      capability: row.capability,
      risk: row.risk,
      inputSchema: schemas.input,
      successSchema: schemas.success,
      errors: Object.fromEntries(
        (row.errors ?? []).map((code) => [code, errorDetailSchemas[code]])
      ),
      policy: row.policy,
      upstream: row.upstream,
      transports: metadataFor(row.id, row.policy),
      execute: row.execute ?? unimplemented(row.id)
    }
    catalog.registerOperation(contract)
  }
  return catalog
}
