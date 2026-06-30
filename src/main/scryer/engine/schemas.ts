/* eslint-disable max-lines -- Why: zod schemas are the runtime contract registry for the 33-operation Scryer catalog and shared result/error shapes. */
import { z } from 'zod'
import { SCRY_VERSION } from './model'
import type {
  ScryerOperationErrorCode,
  ScryerOperationId,
  ScryerValidationFindingCode
} from './types'

export const scryLayerSchema = z.union([z.literal('plan'), z.literal('committed')])
export const scryKindSchema = z.union([
  z.literal('person'),
  z.literal('system'),
  z.literal('container'),
  z.literal('component'),
  z.literal('symbol')
])

export const sourceLocationSchema = z
  .object({
    pattern: z.string().min(1),
    symbol: z.string().optional(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    command: z.string().optional()
  })
  .strict()

export const sourceSchema = z
  .object({
    pattern: z.string().min(1),
    comment: z.string().optional()
  })
  .strict()

export const responsibilitySchema = z
  .object({
    id: z.string().min(1),
    statement: z.string(),
    vagrant: z.boolean().optional(),
    stale: z.boolean().optional(),
    staleProposal: z.string().optional(),
    directives: z.array(z.string()).optional(),
    lastTouchedAt: z.number().optional()
  })
  .strict()

export const propertySchema = z
  .object({
    label: z.string().min(1),
    description: z.string().optional(),
    vagrant: z.boolean().optional(),
    stale: z.boolean().optional(),
    lastTouchedAt: z.number().optional()
  })
  .strict()

export const nodeSchema = z
  .object({
    id: z.string().min(1),
    kind: scryKindSchema,
    name: z.string(),
    parentId: z.string().optional(),
    external: z.boolean().optional(),
    technology: z.string().optional(),
    description: z.string().optional(),
    vagrant: z.boolean().optional(),
    stale: z.boolean().optional(),
    responsibilities: z.array(responsibilitySchema).optional(),
    properties: z.array(propertySchema).optional(),
    icon: z.string().optional(),
    visual: z.boolean().optional(),
    appearance: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional()
  })
  .strict()

export const linkSchema = z
  .object({
    id: z.string().min(1),
    src: z.string().min(1),
    dst: z.string().min(1),
    label: z.string(),
    method: z.string().optional()
  })
  .strict()

export const groupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    memberIds: z.array(z.string()),
    parentGroupId: z.string().optional(),
    parentNodeId: z.string().nullable().optional(),
    responsibilities: z.array(responsibilitySchema).optional(),
    icon: z.string().optional()
  })
  .strict()

export const scryModelSchema = z
  .object({
    version: z.literal(SCRY_VERSION),
    nodes: z.array(nodeSchema),
    links: z.array(linkSchema),
    groups: z.array(groupSchema),
    sourceMap: z.record(z.string(), z.array(sourceLocationSchema)),
    boundaries: z.record(z.string(), z.array(sourceSchema))
  })
  .strict()

export const fieldErrorSchema = z
  .object({
    path: z.string(),
    message: z.string(),
    code: z.string().optional()
  })
  .strict()

export const validationFindingCodeSchema = z.enum([
  'duplicate_id',
  'missing_reference',
  'invalid_hierarchy',
  'invalid_external',
  'empty_responsibility',
  'description_too_long',
  'invalid_symbol_name',
  'empty_symbol',
  'illegal_link',
  'invalid_group',
  'unknown_source_map_target',
  'unknown_boundary_target',
  'disconnected_node',
  'coverage_gap',
  'coverage_overlap',
  'anchor_range_warning',
  'invalid_drift_marker_transition'
] satisfies ScryerValidationFindingCode[])

export const validationFindingSchema = z
  .object({
    code: validationFindingCodeSchema,
    severity: z.union([z.literal('warning'), z.literal('error')]),
    message: z.string(),
    path: z.string().optional(),
    jsonPointer: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export const operationWarningSchema = z
  .object({
    code: z.literal('maintenance_write_failed'),
    message: z.string(),
    target: z
      .union([
        z.literal('sync'),
        z.literal('anchor_baseline'),
        z.literal('committed_source_map_reanchor'),
        z.literal('history'),
        z.literal('baseline')
      ])
      .optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export const invalidContextDetailsSchema = z
  .object({
    reason: z.union([
      z.literal('missing_workspace_root'),
      z.literal('project_outside_workspace'),
      z.literal('unsupported_transport'),
      z.literal('missing_agent_run_id')
    ]),
    field: z.string().optional()
  })
  .strict()

export const incompatibleModelDetailsSchema = z
  .object({
    path: z.string(),
    expectedVersion: z.literal('0.3'),
    actualVersion: z.string().optional(),
    fields: z.array(z.string()).optional(),
    reason: z.union([
      z.literal('missing_version'),
      z.literal('unsupported_version'),
      z.literal('invalid_json'),
      z.literal('unknown_fields'),
      z.literal('invalid_schema')
    ])
  })
  .strict()

const ioTargetSchema = z.union([
  z.literal('model'),
  z.literal('planned'),
  z.literal('history'),
  z.literal('baseline'),
  z.literal('sync'),
  z.literal('anchor_baseline'),
  z.literal('build_edges'),
  z.literal('rules'),
  z.literal('project_tree'),
  z.literal('lock')
])

export const ioErrorDetailsSchema = z
  .object({
    target: ioTargetSchema,
    operation: z.union([
      z.literal('read'),
      z.literal('write'),
      z.literal('rename'),
      z.literal('mkdir'),
      z.literal('append'),
      z.literal('lock')
    ]),
    path: z.string().optional(),
    cause: z.string().optional()
  })
  .strict()

export const errorDetailSchemas = {
  invalid_input: z.undefined(),
  invalid_context: invalidContextDetailsSchema,
  incompatible_model: incompatibleModelDetailsSchema,
  io_error: ioErrorDetailsSchema,
  lock_busy: z
    .object({
      lockPath: z.string().optional(),
      owner: z.string().optional(),
      retryAfterMs: z.number().optional()
    })
    .strict(),
  lease_required: z
    .object({
      policy: z.union([z.literal('write_if_active'), z.literal('completion_gate')]),
      activeLeaseId: z.string().optional(),
      activeOwner: z
        .union([
          z.literal('cli'),
          z.literal('ipc'),
          z.literal('ui'),
          z.literal('agent'),
          z.literal('system'),
          z.literal('test')
        ])
        .optional()
    })
    .strict(),
  operation_not_found: z
    .object({
      operationId: z.string()
    })
    .strict(),
  internal_error: z
    .object({
      reason: z.union([
        z.literal('success_schema_failed'),
        z.literal('error_details_schema_failed'),
        z.literal('undeclared_error_code'),
        z.literal('policy_violation'),
        z.literal('malformed_warning'),
        z.literal('unknown_warning_code'),
        z.literal('unexpected_exception')
      ]),
      contractOperationId: z.string().optional()
    })
    .strict(),
  not_found: z
    .object({
      entity: z.union([
        z.literal('project'),
        z.literal('node'),
        z.literal('link'),
        z.literal('group'),
        z.literal('responsibility'),
        z.literal('property'),
        z.literal('source_entry'),
        z.literal('boundary'),
        z.literal('rule_topic'),
        z.literal('agent_run')
      ]),
      id: z.string(),
      field: z.string().optional()
    })
    .strict(),
  illegal_link: z
    .object({
      reason: z.union([
        z.literal('self_link'),
        z.literal('ancestor_descendant'),
        z.literal('same_level_reference'),
        z.literal('duplicate_link')
      ]),
      src: z.string(),
      dst: z.string(),
      linkId: z.string().optional()
    })
    .strict(),
  validation_failed: z
    .object({
      findings: z.array(validationFindingSchema)
    })
    .strict(),
  agent_run_required: z
    .object({
      mode: z.literal('agent_completion'),
      reason: z.union([
        z.literal('missing_context'),
        z.literal('inactive_run'),
        z.literal('lease_mismatch'),
        z.literal('run_not_complete')
      ]),
      agentRunId: z.string().optional(),
      leaseId: z.string().optional()
    })
    .strict()
} satisfies Record<ScryerOperationErrorCode, z.ZodTypeAny>

export const modelReadInputSchema = z
  .object({
    project: z.string().optional(),
    view: z.union([z.literal('overview'), z.literal('subtree'), z.literal('full')]).optional(),
    node: z.string().optional(),
    layer: scryLayerSchema.optional()
  })
  .strict()

const recommendedReadSchema = z
  .object({
    operationId: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    reason: z.string()
  })
  .strict()

const readNodeSummarySchema = z
  .object({
    id: z.string(),
    kind: scryKindSchema,
    name: z.string(),
    path: z.string(),
    depth: z.number().int().nonnegative(),
    childCount: z.number().int().nonnegative(),
    nResp: z.number().int().nonnegative(),
    nProps: z.number().int().nonnegative(),
    parentId: z.string().optional(),
    description: z.string().optional(),
    technology: z.string().optional(),
    external: z.boolean().optional(),
    stale: z.boolean().optional(),
    vagrant: z.boolean().optional()
  })
  .strict()

const overviewNodeSchema = readNodeSummarySchema
  .extend({
    directSymbolCount: z.number().int().nonnegative(),
    responsibilityCount: z.number().int().nonnegative(),
    propertyCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    hasSourceAnchors: z.boolean(),
    hasBoundaries: z.boolean(),
    hasExternalLinks: z.boolean(),
    hiddenSymbolDescendants: z.boolean(),
    hasChildren: z.boolean()
  })
  .omit({ nResp: true, nProps: true })
  .strict()

const modelReadOverviewSuccessSchema = z
  .object({
    view: z.literal('overview'),
    layer: scryLayerSchema,
    version: z.literal(SCRY_VERSION),
    nodeCount: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    overview: z.array(overviewNodeSchema),
    recommendedNextReads: z.array(recommendedReadSchema),
    baselineRefreshed: z.boolean().optional()
  })
  .strict()

const modelReadSubtreeSuccessSchema = z
  .object({
    view: z.literal('subtree'),
    layer: scryLayerSchema,
    version: z.literal(SCRY_VERSION),
    nodeCount: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    node: readNodeSummarySchema,
    descendants: z.array(nodeSchema),
    internalLinks: z.array(linkSchema),
    externalLinks: z.array(linkSchema),
    contextNodes: z.array(readNodeSummarySchema),
    referencesForChildren: z.array(
      z
        .object({
          id: z.string(),
          kind: scryKindSchema,
          name: z.string(),
          path: z.string(),
          direction: z.union([z.literal('incoming'), z.literal('outgoing')]),
          label: z.string()
        })
        .strict()
    ),
    sourceMap: z.record(z.string(), z.array(sourceLocationSchema)),
    boundaries: z.record(z.string(), z.array(sourceSchema)),
    degraded: z.boolean(),
    truncated: z.boolean(),
    approximateSizeBytes: z.number().int().nonnegative().optional(),
    children: z.array(readNodeSummarySchema).optional(),
    recommendedNextReads: z.array(recommendedReadSchema),
    baselineRefreshed: z.boolean().optional()
  })
  .strict()

const modelReadFullSuccessSchema = z
  .object({
    view: z.literal('full'),
    layer: scryLayerSchema,
    version: z.literal(SCRY_VERSION),
    nodeCount: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    model: scryModelSchema,
    baselineRefreshed: z.boolean().optional()
  })
  .strict()

export const modelReadSuccessSchema = z.discriminatedUnion('view', [
  modelReadOverviewSuccessSchema,
  modelReadSubtreeSuccessSchema,
  modelReadFullSuccessSchema
])

export const modelSearchInputSchema = z
  .object({
    project: z.string().optional(),
    query: z.string().trim().min(1),
    kind: scryKindSchema.optional(),
    layer: scryLayerSchema.optional()
  })
  .strict()

const searchMatchSchema = z
  .object({
    field: z.string(),
    value: z.string(),
    match: z.union([z.literal('exact'), z.literal('fuzzy')]),
    score: z.number()
  })
  .strict()

const searchHitSchema = z
  .object({
    id: z.string(),
    kind: scryKindSchema,
    name: z.string(),
    path: z.string(),
    score: z.number(),
    matched: z.array(searchMatchSchema),
    parentId: z.string().optional()
  })
  .strict()

export const modelSearchSuccessSchema = z
  .object({
    layer: scryLayerSchema,
    query: z.string(),
    kind: scryKindSchema.optional(),
    resultCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    hits: z.array(searchHitSchema)
  })
  .strict()

const queryOperatorSchema = z.union([
  z.literal('eq'),
  z.literal('ne'),
  z.literal('contains'),
  z.literal('gt'),
  z.literal('gte'),
  z.literal('lt'),
  z.literal('lte'),
  z.literal('exists'),
  z.literal('absent')
])

const rawQueryConditionSchema = z
  .object({
    field: z.string().min(1),
    op: queryOperatorSchema.optional(),
    operator: queryOperatorSchema.optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.op && !value.operator) {
      ctx.addIssue({ code: 'custom', path: ['op'], message: 'Required query operator' })
    }
    if (value.op && value.operator && value.op !== value.operator) {
      ctx.addIssue({
        code: 'custom',
        path: ['operator'],
        message: 'Conflicting query operator aliases'
      })
    }
  })
  .transform(({ field, op, operator, value }) => ({
    field,
    op: op ?? operator!,
    ...(value !== undefined ? { value } : {})
  }))

export const modelQueryInputSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value
    }
    const record = value as Record<string, unknown>
    if (record.where === undefined && record.conditions !== undefined) {
      return { ...record, where: record.conditions }
    }
    if (record.where !== undefined && record.conditions !== undefined) {
      return { ...record, __whereConflict: true }
    }
    return record
  },
  z
    .object({
      project: z.string().optional(),
      where: z.array(rawQueryConditionSchema).min(1),
      conditions: z.undefined().optional(),
      __whereConflict: z.undefined().optional(),
      under: z.string().optional(),
      layer: scryLayerSchema.optional()
    })
    .strict()
    .transform(({ project, where, under, layer }) => ({
      ...(project ? { project } : {}),
      where,
      ...(under ? { under } : {}),
      ...(layer ? { layer } : {})
    }))
)

const queryHitSchema = z
  .object({
    id: z.string(),
    kind: scryKindSchema,
    name: z.string(),
    path: z.string(),
    nResp: z.number().int().nonnegative(),
    nProps: z.number().int().nonnegative(),
    childCount: z.number().int().nonnegative(),
    parentId: z.string().optional(),
    external: z.boolean().optional(),
    visual: z.boolean().optional(),
    empty: z.boolean().optional(),
    vagrant: z.boolean().optional()
  })
  .strict()

export const modelQuerySuccessSchema = z
  .object({
    layer: scryLayerSchema,
    resultCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    hits: z.array(queryHitSchema),
    where: z.array(
      z
        .object({
          field: z.string(),
          op: queryOperatorSchema,
          value: z.union([z.string(), z.number(), z.boolean()]).optional()
        })
        .strict()
    ),
    under: z.string().optional()
  })
  .strict()

const ruleIndexEntrySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    tags: z.array(z.string())
  })
  .strict()

const ruleDetailSchema = ruleIndexEntrySchema
  .extend({
    body: z.string()
  })
  .strict()

export const rulesReadInputSchema = z
  .object({
    topic: z.string().optional()
  })
  .strict()

export const rulesReadSuccessSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('index'),
      rules: z.array(ruleIndexEntrySchema)
    })
    .strict(),
  z
    .object({
      mode: z.literal('topic'),
      topic: z.string(),
      rules: z.array(ruleDetailSchema)
    })
    .strict(),
  z
    .object({
      mode: z.literal('miss'),
      topic: z.string(),
      guidance: z.literal('choose_topic_from_index'),
      rules: z.array(ruleIndexEntrySchema)
    })
    .strict()
])

const codebaseEntrySchema = z
  .object({
    path: z.string(),
    name: z.string(),
    kind: z.union([z.literal('file'), z.literal('directory')]),
    depth: z.number().int().nonnegative(),
    markers: z.array(
      z.union([z.literal('manifest'), z.literal('infrastructure'), z.literal('environment')])
    )
  })
  .strict()

export const codebaseReadInputSchema = z
  .object({
    project: z.string().optional(),
    path: z.string().optional(),
    maxDepth: z.number().int().min(0).max(12).optional(),
    maxEntries: z.number().int().min(1).max(1000).optional()
  })
  .strict()

export const codebaseReadSuccessSchema = z
  .object({
    root: z.string(),
    entries: z.array(codebaseEntrySchema),
    summary: z
      .object({
        fileCount: z.number().int().nonnegative(),
        directoryCount: z.number().int().nonnegative(),
        manifestCount: z.number().int().nonnegative(),
        infrastructureCount: z.number().int().nonnegative(),
        environmentCount: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative()
      })
      .strict(),
    truncated: z.boolean()
  })
  .strict()

export const modelValidateInputSchema = z
  .object({
    project: z.string().optional()
  })
  .strict()

export const modelValidateSuccessSchema = z
  .object({
    findings: z.array(validationFindingSchema),
    validationWarningCount: z.number().int().nonnegative(),
    validationErrorCount: z.number().int().nonnegative()
  })
  .strict()

export const updateNodeItemSchema = z
  .object({
    node_id: z.string().min(1),
    kind: scryKindSchema.optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    technology: z.string().optional(),
    external: z.boolean().optional(),
    responsibilities: z.array(responsibilitySchema).optional(),
    properties: z.array(propertySchema).optional(),
    visual: z.boolean().optional(),
    appearance: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
    parent_id: z.string().nullable().optional()
  })
  .strict()

export const nodeUpdateInputSchema = z
  .object({
    project: z.string().optional(),
    nodes: z.array(updateNodeItemSchema).min(1)
  })
  .strict()

export const pendingSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    byChange: z.record(z.string(), z.number().int().nonnegative()),
    toImplement: z.number().int().nonnegative().optional(),
    toReimplement: z.number().int().nonnegative().optional(),
    toMove: z.number().int().nonnegative().optional(),
    toDelete: z.number().int().nonnegative().optional(),
    toRepoint: z.number().int().nonnegative().optional()
  })
  .strict()

export const nodeUpdateSuccessSchema = z
  .object({
    updatedCount: z.number().int().nonnegative(),
    findings: z.array(validationFindingSchema).optional(),
    pendingSummary: pendingSummarySchema.optional()
  })
  .strict()

export const linkAddInputSchema = z
  .object({
    project: z.string().optional(),
    links: z
      .array(
        z
          .object({
            src: z.string().min(1),
            dst: z.string().min(1),
            label: z.string(),
            method: z.string().optional()
          })
          .strict()
      )
      .min(1)
  })
  .strict()

export const linkAddSuccessSchema = z
  .object({
    addedIds: z.array(z.string()),
    findings: z.array(validationFindingSchema).optional(),
    pendingSummary: pendingSummarySchema.optional()
  })
  .strict()

export const linkDeleteInputSchema = z
  .object({
    project: z.string().optional(),
    link_ids: z.array(z.string().min(1)).min(1)
  })
  .strict()

export const linkDeleteSuccessSchema = z
  .object({
    deletedCount: z.number().int().nonnegative(),
    missingIds: z.array(z.string()).optional(),
    pendingSummary: pendingSummarySchema.optional()
  })
  .strict()

export const planPendingInputSchema = z
  .object({
    project: z.string().optional()
  })
  .strict()

export const pendingChangeSchema = z
  .object({
    kind: z.union([
      z.literal('node'),
      z.literal('link'),
      z.literal('responsibility'),
      z.literal('property'),
      z.literal('group')
    ]),
    id: z.string(),
    ownerId: z.string().optional(),
    label: z.string(),
    changes: z.array(z.record(z.string(), z.unknown()))
  })
  .passthrough()

export const planPendingSuccessSchema = z
  .object({
    clean: z.boolean(),
    changes: z.array(pendingChangeSchema),
    summary: pendingSummarySchema
  })
  .strict()

export const planFoldInputSchema = z
  .object({
    project: z.string().optional(),
    mode: z.union([z.literal('manual'), z.literal('agent_completion')]).default('manual'),
    node_id: z.string().optional(),
    responsibility_ids: z.array(z.string()).optional(),
    property_labels: z.array(z.string()).optional(),
    properties: z.array(z.object({ node_id: z.string(), label: z.string() }).strict()).optional(),
    link_ids: z.array(z.string()).optional(),
    group_ids: z.array(z.string()).optional(),
    include_descendants: z.boolean().optional(),
    all: z.boolean().optional()
  })
  .strict()

export const foldedItemSchema = z
  .object({
    kind: z.union([
      z.literal('node'),
      z.literal('link'),
      z.literal('responsibility'),
      z.literal('property'),
      z.literal('group')
    ]),
    id: z.string(),
    ownerId: z.string().optional(),
    change: z.string().optional()
  })
  .strict()

export const planFoldSuccessSchema = z
  .object({
    folded: z.array(foldedItemSchema),
    remaining: z.array(pendingChangeSchema),
    findings: z.array(validationFindingSchema).optional()
  })
  .strict()

const stringProjectSchema = z.object({ project: z.string().optional() }).strict()
const countResultSchema = z.record(z.string(), z.unknown())
const emptyInputSchema = z.object({}).strict()

export const operationSchemas: Record<
  ScryerOperationId,
  { input: z.ZodTypeAny; success: z.ZodTypeAny }
> = {
  'scryer.model.read': { input: modelReadInputSchema, success: modelReadSuccessSchema },
  'scryer.model.search': {
    input: modelSearchInputSchema,
    success: modelSearchSuccessSchema
  },
  'scryer.model.query': {
    input: modelQueryInputSchema,
    success: modelQuerySuccessSchema
  },
  'scryer.rules.read': {
    input: rulesReadInputSchema,
    success: rulesReadSuccessSchema
  },
  'scryer.codebase.read': {
    input: codebaseReadInputSchema,
    success: codebaseReadSuccessSchema
  },
  'scryer.model.validate': {
    input: modelValidateInputSchema,
    success: modelValidateSuccessSchema
  },
  'scryer.model.health': {
    input: z.object({ project: z.string().optional(), node_id: z.string().optional() }).strict(),
    success: countResultSchema
  },
  'scryer.plan.pending': {
    input: planPendingInputSchema,
    success: planPendingSuccessSchema
  },
  'scryer.node.update': { input: nodeUpdateInputSchema, success: nodeUpdateSuccessSchema },
  'scryer.link.add': { input: linkAddInputSchema, success: linkAddSuccessSchema },
  'scryer.link.update': {
    input: z
      .object({
        project: z.string().optional(),
        links: z
          .array(
            z
              .object({
                link_id: z.string().min(1),
                label: z.string().optional(),
                method: z.string().optional()
              })
              .strict()
          )
          .min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.link.delete': { input: linkDeleteInputSchema, success: linkDeleteSuccessSchema },
  'scryer.node.set-subtree': {
    input: z
      .object({ project: z.string().optional(), node_id: z.string(), data: z.unknown() })
      .strict(),
    success: countResultSchema
  },
  'scryer.node.delete': {
    input: z
      .object({ project: z.string().optional(), node_ids: z.array(z.string()).min(1) })
      .strict(),
    success: countResultSchema
  },
  'scryer.node.move': {
    input: z
      .object({
        project: z.string().optional(),
        moves: z
          .array(
            z
              .object({ node_id: z.string(), new_parent_id: z.string().nullable().optional() })
              .strict()
          )
          .min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.responsibility.move': {
    input: z
      .object({
        project: z.string().optional(),
        moves: z
          .array(
            z
              .object({
                responsibility_id: z.string(),
                from_node_id: z.string(),
                to_node_id: z.string()
              })
              .strict()
          )
          .min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.group.set': {
    input: z.object({ project: z.string().optional(), data: z.unknown() }).strict(),
    success: countResultSchema
  },
  'scryer.group.update': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.group.delete': {
    input: z.object({ project: z.string().optional(), group_id: z.string() }).strict(),
    success: countResultSchema
  },
  'scryer.person.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.system.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.container.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.component.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.group.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.symbol.add': {
    input: z
      .object({
        project: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).min(1)
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.source.update': {
    input: z
      .object({
        project: z.string().optional(),
        entries: z.array(z.record(z.string(), z.unknown())).optional(),
        schemas: z.array(z.record(z.string(), z.unknown())).optional(),
        boundaries: z.array(z.record(z.string(), z.unknown())).optional()
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.plan.fold': { input: planFoldInputSchema, success: planFoldSuccessSchema },
  'scryer.model.set': {
    input: z.object({ project: z.string().optional(), data: z.unknown() }).strict(),
    success: countResultSchema
  },
  'scryer.container.fill': {
    input: z
      .object({
        project: z.string().optional(),
        container_id: z.string(),
        components: z.array(z.record(z.string(), z.unknown())).min(1),
        links: z.array(z.record(z.string(), z.unknown())).optional(),
        groups: z.array(z.record(z.string(), z.unknown())).optional()
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.node.descope': {
    input: z
      .object({ project: z.string().optional(), node_ids: z.array(z.string()).min(1) })
      .strict(),
    success: countResultSchema
  },
  'scryer.drift.get': { input: stringProjectSchema, success: countResultSchema },
  'scryer.drift.flag': {
    input: z
      .object({
        project: z.string().optional(),
        node_id: z.string(),
        undescribed: z.array(z.unknown()).optional(),
        new_nodes: z.array(z.unknown()).optional(),
        undescribed_properties: z.array(z.unknown()).optional(),
        stale: z.array(z.unknown()).optional(),
        stale_properties: z.array(z.unknown()).optional(),
        stale_nodes: z.array(z.unknown()).optional()
      })
      .strict(),
    success: countResultSchema
  },
  'scryer.drift.reconcile': { input: stringProjectSchema, success: countResultSchema }
}

export const unimplementedSuccessSchema = emptyInputSchema
