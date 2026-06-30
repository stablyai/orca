/* eslint-disable max-lines -- Why: this file is the first TypeScript migration of Scryer's MCP tool surface, kept together so tool semantics and shared validation stay auditable while the bridge is still new. */
import { readFile } from 'fs/promises'
import type {
  C4Edge,
  C4Kind,
  C4ModelData,
  C4Node,
  Contract,
  ContractItem,
  Flow,
  Group,
  ModelProperty,
  ScryerToolCall,
  ScryerToolResult,
  SourceLocation,
  Status
} from '../../shared/scryer/model-types'
import { parseModelData } from '../../shared/scryer/parse-model'
import {
  getProjectScryerDir,
  getProjectModelPath,
  readBaseline,
  readModel,
  setImplementing,
  writeBaseline,
  writeModel
} from './model-store'
import { projectStructure } from './structure'
import { SCRYER_RULES, TASK_INSTRUCTIONS } from '../../shared/scryer/rules'
import { createScryerEngine, type ScryerOperationId } from './engine'

const defaultScryerEngine = createScryerEngine()

function ok(content: string, data?: unknown): ScryerToolResult {
  return { ok: true, content, data }
}

function fail(content: string, data?: unknown): ScryerToolResult {
  return { ok: false, content, data }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

async function isStrictScryerModel(projectPath: string): Promise<boolean> {
  const candidates = [
    `${getProjectScryerDir(projectPath)}/planned.scry`,
    getProjectModelPath(projectPath)
  ]
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await readFile(candidate, 'utf8')) as unknown
      if (isRecord(raw) && raw.version === '0.3') {
        return true
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false
}

async function readMcpCompatibleModel(projectPath: string): Promise<C4ModelData> {
  const candidates = [
    `${getProjectScryerDir(projectPath)}/planned.scry`,
    getProjectModelPath(projectPath)
  ]
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8')
      const data = JSON.parse(raw) as unknown
      if (isRecord(data) && data.version === '0.3') {
        return { ...parseModelData(raw), projectPath }
      }
    } catch {
      // Fall through to the next candidate, then legacy model storage.
    }
  }
  return readModel(projectPath)
}

function scryerOperationContext(projectPath: string, requestId: string) {
  return {
    requestId,
    transport: 'agent' as const,
    caller: 'agent' as const,
    cwd: projectPath,
    projectRoot: projectPath
  }
}

async function executeStrictScryerOperation(
  projectPath: string,
  operationId: ScryerOperationId,
  input: Record<string, unknown>,
  content: string
): Promise<ScryerToolResult> {
  const result = await defaultScryerEngine.executeOperation(
    operationId,
    input,
    scryerOperationContext(projectPath, `mcp-${operationId.replaceAll('.', '-')}-${Date.now()}`)
  )
  if (!result.ok) {
    return fail(result.error.message, result.error)
  }
  return ok(content, result.result)
}

function normalizeContract(value: unknown): Contract | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return {
    expect: Array.isArray(value.expect) ? (value.expect as Contract['expect']) : [],
    ask: Array.isArray(value.ask) ? (value.ask as Contract['ask']) : [],
    never: Array.isArray(value.never) ? (value.never as Contract['never']) : []
  }
}

function normalizeSources(value: unknown): C4Node['data']['sources'] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter(isRecord)
    .map((source) => ({
      pattern: String(source.pattern ?? ''),
      comment: String(source.comment ?? '')
    }))
    .filter((source) => source.pattern)
}

function normalizeSourceLocations(value: unknown): SourceLocation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter(isRecord)
    .map((source) => ({
      pattern: String(source.pattern ?? ''),
      ...(typeof source.line === 'number' ? { line: source.line } : {}),
      ...(typeof source.endLine === 'number' ? { endLine: source.endLine } : {}),
      ...(typeof source.command === 'string' ? { command: source.command } : {})
    }))
    .filter((source) => source.pattern)
}

function normalizeProperties(value: unknown): ModelProperty[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter(isRecord)
    .map((property) => ({
      label: String(property.label ?? ''),
      description: String(property.description ?? '')
    }))
    .filter((property) => property.label)
}

function isStatus(value: unknown): value is Status {
  return (
    value === 'proposed' || value === 'implemented' || value === 'verified' || value === 'vagrant'
  )
}

function isKind(value: unknown): value is C4Kind {
  return (
    value === 'person' ||
    value === 'system' ||
    value === 'container' ||
    value === 'component' ||
    value === 'operation' ||
    value === 'process' ||
    value === 'model'
  )
}

function nodeTypeForKind(kind: C4Kind): C4Node['type'] {
  if (kind === 'operation' || kind === 'process' || kind === 'model') {
    return kind
  }
  return 'c4'
}

function kindLabel(kind: C4Kind): string {
  return kind
}

function makeEdgeId(source: string, target: string): string {
  return `edge-${source}-${target}`
}

function validateIdentifier(name: string, label: string): string | null {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? null : `${label} must be a valid code identifier`
}

function validateTypeName(name: string, label: string): string | null {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name) ? null : `${label} must be a valid type name`
}

function validatePropertyLabels(properties: ModelProperty[], label: string): string | null {
  for (const property of properties) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property.label)) {
      return `${label} has invalid property label '${property.label}'`
    }
  }
  return null
}

function validateParent(model: C4ModelData, node: C4Node): string | null {
  const parent = node.parentId
    ? model.nodes.find((candidate) => candidate.id === node.parentId)
    : null
  if (node.data.kind === 'person' || node.data.kind === 'system') {
    return node.parentId ? `${node.data.kind} '${node.data.name}' must be top-level` : null
  }
  if (node.data.kind === 'container' && parent?.data.kind !== 'system') {
    return `Container '${node.data.name}' must have a system parent`
  }
  if (node.data.kind === 'component' && parent?.data.kind !== 'container') {
    return `Component '${node.data.name}' must have a container parent`
  }
  if (
    (node.data.kind === 'operation' ||
      node.data.kind === 'process' ||
      node.data.kind === 'model') &&
    parent?.data.kind !== 'component'
  ) {
    return `${node.data.kind} '${node.data.name}' must have a component parent`
  }
  return null
}

function validateNoExternalChildren(model: C4ModelData): string[] {
  const errors: string[] = []
  const byId = new Map(model.nodes.map((node) => [node.id, node]))
  for (const node of model.nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : null
    if (parent?.data.kind === 'system' && parent.data.external) {
      errors.push(`External system '${parent.data.name}' cannot contain '${node.data.name}'`)
    }
  }
  return errors
}

const MENTION_RE = /@\[([^\]]+)\]/g

function validateMentionEdges(model: C4ModelData): string[] {
  const errors: string[] = []
  const siblingsByParent = new Map<string, C4Node[]>()
  for (const node of model.nodes) {
    const key = node.parentId ?? ''
    siblingsByParent.set(key, [...(siblingsByParent.get(key) ?? []), node])
  }
  const edgeKeys = new Set<string>()
  for (const edge of model.edges) {
    edgeKeys.add(`${edge.source}->${edge.target}`)
    edgeKeys.add(`${edge.target}->${edge.source}`)
  }
  for (const node of model.nodes) {
    const siblings = siblingsByParent.get(node.parentId ?? '') ?? []
    for (const match of node.data.description.matchAll(MENTION_RE)) {
      const mention = match[1]
      const target = siblings.find(
        (candidate) =>
          candidate.id === mention ||
          candidate.data.name === mention ||
          candidate.data.name.toLowerCase() === mention.toLowerCase()
      )
      if (!target) {
        errors.push(`${node.data.name} mentions ${mention} but no sibling node matches it`)
        continue
      }
      if (target.id === node.id) {
        continue
      }
      if (!edgeKeys.has(`${node.id}->${target.id}`)) {
        errors.push(
          `${node.data.name} mentions ${target.data.name} but no relationship edge connects them`
        )
      }
    }
  }
  return errors
}

function inheritedExpectItems(
  model: C4ModelData,
  node: C4Node,
  nextContract?: Contract
): Contract['expect'] {
  const chain = ancestorChain(model, node)
  return [
    ...chain,
    { ...node, data: { ...node.data, contract: nextContract ?? node.data.contract } }
  ].flatMap((item) => item.data.contract?.expect ?? [])
}

function validateVerifiedGate(model: C4ModelData, node: C4Node, nextContract?: Contract): string[] {
  return inheritedExpectItems(model, node, nextContract)
    .filter((item) => typeof item !== 'object' || item.passed !== true)
    .map((item) => `- ${typeof item === 'string' ? item : item.text}`)
}

function validateModelShape(model: C4ModelData): string[] {
  const errors: string[] = []
  const nodeIds = new Set(model.nodes.map((node) => node.id))
  for (const node of model.nodes) {
    if (!isKind(node.data.kind)) {
      errors.push(`Node '${node.id}' has invalid kind '${String(node.data.kind)}'`)
      continue
    }
    const parentError = validateParent(model, node)
    if (parentError) {
      errors.push(parentError)
    }
    if (node.parentId && !nodeIds.has(node.parentId)) {
      errors.push(`Node '${node.data.name}' references missing parent '${node.parentId}'`)
    }
    if (
      node.data.description.length > 200 &&
      !['operation', 'process', 'model'].includes(node.data.kind)
    ) {
      errors.push(`Description for '${node.data.name}' must be 200 characters or less`)
    }
    if (node.data.technology && node.data.technology.length > 28) {
      errors.push(
        `Technology '${node.data.technology}' on '${node.data.name}' exceeds 28 character limit`
      )
    }
    if (node.data.kind === 'operation') {
      const error = validateIdentifier(node.data.name, `operation '${node.id}'`)
      if (error) {
        errors.push(error)
      }
    }
    if (node.data.kind === 'model') {
      const error = validateTypeName(node.data.name, `model '${node.id}'`)
      if (error) {
        errors.push(error)
      }
      const propertyError = validatePropertyLabels(node.data.properties ?? [], `node '${node.id}'`)
      if (propertyError) {
        errors.push(propertyError)
      }
    }
  }
  errors.push(...validateNoExternalChildren(model))
  for (const edge of model.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push(`Edge '${edge.id}' references a missing node`)
    }
    if ((edge.data?.label ?? '').length > 30) {
      errors.push(`Edge label '${edge.data?.label}' exceeds 30 character limit`)
    }
  }
  return errors
}

function stripPositions(model: C4ModelData): C4ModelData {
  return {
    ...model,
    nodes: model.nodes.map(
      ({ position: _position, selected: _selected, measured: _measured, ...node }) => node
    )
  }
}

function stripNodeForAgent(node: C4Node): Omit<C4Node, 'position' | 'selected' | 'measured'> {
  const { position: _position, selected: _selected, measured: _measured, ...rest } = node
  return rest
}

function nextNodeId(model: C4ModelData): string {
  let max = 0
  for (const node of model.nodes) {
    const match = /^node-(\d+)$/.exec(node.id)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `node-${max + 1}`
}

function ancestorChain(model: C4ModelData, node: C4Node): C4Node[] {
  const chain: C4Node[] = []
  let current = node
  while (current.parentId) {
    const parent = model.nodes.find((candidate) => candidate.id === current.parentId)
    if (!parent) {
      break
    }
    chain.unshift(parent)
    current = parent
  }
  return chain
}

function mergeContract(chain: C4Node[], node: C4Node): Contract {
  const merged: Contract = { expect: [], ask: [], never: [] }
  for (const item of [...chain, node]) {
    const contract = item.data.contract
    if (!contract) {
      continue
    }
    merged.expect.push(...contract.expect)
    merged.ask.push(...contract.ask)
    merged.never.push(...contract.never)
  }
  return merged
}

function collectNotes(chain: C4Node[], node: C4Node): string[] {
  const notes: string[] = []
  for (const ancestor of chain) {
    for (const note of ancestor.data.notes ?? []) {
      notes.push(`${ancestor.data.name}: ${note}`)
    }
  }
  notes.push(...(node.data.notes ?? []))
  return notes
}

function hasStatusChildren(model: C4ModelData, node: C4Node): boolean {
  return model.nodes.some(
    (candidate) =>
      candidate.parentId === node.id &&
      candidate.data.status !== undefined &&
      ((node.data.kind === 'container' && candidate.data.kind === 'component') ||
        (node.data.kind === 'system' && candidate.data.kind === 'container'))
  )
}

function childrenAllDone(model: C4ModelData, node: C4Node): boolean {
  const childKind =
    node.data.kind === 'container' ? 'component' : node.data.kind === 'system' ? 'container' : null
  if (!childKind) {
    return true
  }
  return model.nodes
    .filter(
      (candidate) =>
        candidate.parentId === node.id && candidate.data.kind === childKind && candidate.data.status
    )
    .every((candidate) => ['implemented', 'verified', 'vagrant'].includes(candidate.data.status!))
}

function isSatisfied(model: C4ModelData, node: C4Node): boolean {
  if (node.data.external) {
    return true
  }
  if (hasStatusChildren(model, node)) {
    return childrenAllDone(model, node)
  }
  return (
    node.data.status === undefined ||
    ['implemented', 'verified', 'vagrant'].includes(node.data.status)
  )
}

function contractItemText(item: ContractItem): string {
  return typeof item === 'string' ? item : item.text
}

function contractIsEmpty(contract?: Contract): boolean {
  return (
    !contract ||
    (contract.expect.length === 0 && contract.ask.length === 0 && contract.never.length === 0)
  )
}

function formatContractBlock(contract: Contract, indent = ''): string {
  const lines: string[] = []
  if (contract.expect.length > 0) {
    lines.push(
      `${indent}MUST:`,
      ...contract.expect.map((item) => `${indent}  - ${contractItemText(item)}`)
    )
  }
  if (contract.ask.length > 0) {
    lines.push(
      `${indent}ASK USER FIRST:`,
      ...contract.ask.map((item) => `${indent}  - ${contractItemText(item)}`)
    )
  }
  if (contract.never.length > 0) {
    lines.push(
      `${indent}NEVER:`,
      ...contract.never.map((item) => `${indent}  - ${contractItemText(item)}`)
    )
  }
  return lines.join('\n')
}

function statusStr(status?: Status): string {
  return status ?? 'none'
}

function kindStr(kind: C4Kind): string {
  return kind
}

function groupMemberIds(group: Group): string[] {
  const legacy = group as Group & { member_ids?: string[] }
  return Array.isArray(group.memberIds) ? group.memberIds : (legacy.member_ids ?? [])
}

function formatContractAndNotes(title: string, contract: Contract, notes: string[]): string {
  const lines: string[] = []
  if (!contractIsEmpty(contract)) {
    lines.push(`\n${title} Contract (MUST follow):`, formatContractBlock(contract, '  '))
  }
  if (notes.length > 0) {
    lines.push(`\n${title} Notes:`, ...notes.map((note) => `  - ${note}`))
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function findNextName(
  blockedNodes: C4Node[],
  readyNodes: C4Node[],
  currentWorkUnit: C4Node[]
): string | null {
  const current = new Set(currentWorkUnit.map((node) => node.id))
  const nextReady = readyNodes.find((node) => !current.has(node.id))
  if (nextReady) {
    return nextReady.data.name
  }
  return blockedNodes[0]?.data.name ?? null
}

function collectDescendantIds(model: C4ModelData, nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of model.nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        changed = true
      }
    }
  }
  return ids
}

function cleanupReferences(model: C4ModelData, deletedIds: Set<string>): void {
  for (const id of deletedIds) {
    delete model.sourceMap?.[id]
  }
  model.groups = (model.groups ?? [])
    .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => !deletedIds.has(id)) }))
    .filter((group) => group.memberIds.length > 0)
}

async function writeModelAndBaseline(projectPath: string, model: C4ModelData): Promise<void> {
  await writeModel(projectPath, model)
  await writeBaseline(projectPath, model)
}

async function setModel(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (typeof args.data !== 'string') {
    return fail('set_model requires a JSON string in arguments.data')
  }
  if (await isStrictScryerModel(projectPath)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(args.data) as unknown
    } catch (error) {
      return fail(`Invalid model JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    return executeStrictScryerOperation(
      projectPath,
      'scryer.model.set',
      { data: parsed },
      'Set model'
    )
  }
  let model: C4ModelData
  try {
    model = stripPositions(parseModelData(args.data))
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  const errors = validateModelShape(model)
  if (errors.length > 0) {
    return fail(errors.join('\n'))
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(`Set model (${model.nodes.length} nodes, ${model.edges.length} edges)`, model)
}

async function getTask(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  const model = await readMcpCompatibleModel(projectPath)
  const scopeId = asString(args.node_id ?? args.nodeId)

  const isDescendantOf = (nodeId: string, ancestorId: string): boolean => {
    let current = model.nodes.find((node) => node.id === nodeId)
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true
      }
      current = model.nodes.find((node) => node.id === current?.parentId)
    }
    return false
  }

  const inScope = (node: C4Node): boolean =>
    !scopeId || node.id === scopeId || isDescendantOf(node.id, scopeId)

  const parentIsExternal = (node: C4Node): boolean => {
    const parent = node.parentId
      ? model.nodes.find((candidate) => candidate.id === node.parentId)
      : null
    return parent?.data.external === true
  }

  const taskNodes = model.nodes.filter((node) => {
    if (!['container', 'component'].includes(node.data.kind)) {
      return false
    }
    if (!node.data.status || node.data.status === 'vagrant') {
      return false
    }
    if (parentIsExternal(node)) {
      return false
    }
    if (node.data.kind === 'container' && hasStatusChildren(model, node)) {
      return false
    }
    return inScope(node)
  })

  if (taskNodes.length === 0) {
    return ok('All architecture tasks complete.')
  }

  const workNodes = taskNodes.filter((node) => !isSatisfied(model, node))

  if (workNodes.length === 0) {
    const completed = taskNodes.filter((node) => isSatisfied(model, node)).length
    const propagateNodes = model.nodes.filter((node) => {
      if (!['container', 'system'].includes(node.data.kind)) {
        return false
      }
      if (node.data.status === 'implemented' || node.data.status === 'verified') {
        return false
      }
      return hasStatusChildren(model, node) && childrenAllDone(model, node) && inScope(node)
    })

    if (propagateNodes.length === 0) {
      return ok('All architecture tasks complete.')
    }

    const pendingMembers = model.nodes.filter((node) => {
      if (!['operation', 'process', 'model'].includes(node.data.kind)) {
        return false
      }
      if (node.data.status !== 'proposed') {
        return false
      }
      const parent = node.parentId
        ? model.nodes.find((candidate) => candidate.id === node.parentId)
        : null
      return parent?.data.kind === 'component' && isSatisfied(model, parent)
    })

    const output = [
      `All ${completed} tasks complete.`,
      '',
      'Mark these parent nodes as implemented:',
      '```',
      `update_nodes(nodes: [${propagateNodes
        .map(
          (node) =>
            `{node_id: "${node.id}", status: "implemented", reason: "All child tasks are implemented", source: [{pattern: "src/module/**/*.ts"}]}`
        )
        .join(', ')}])`,
      '```',
      ...propagateNodes.map((node) => `- ${node.data.name}`),
      pendingMembers.length > 0
        ? [
            '',
            'These member nodes are still proposed — mark as implemented with a reason explaining what was built:',
            ...pendingMembers.map((member) => {
              const parent = model.nodes.find((node) => node.id === member.parentId)
              return `  - ${member.data.name} [${member.id}] (${kindStr(member.data.kind)}, ${statusStr(member.data.status)}) in ${parent?.data.name ?? 'unknown'}`
            })
          ].join('\n')
        : '',
      (model.flows ?? []).length > 0 ? 'Then call get_task again to validate flows.' : ''
    ]
      .filter(Boolean)
      .join('\n')

    return ok(output, propagateNodes)
  }

  const depsSatisfied = (node: C4Node): boolean => {
    if (node.data.kind !== 'component') {
      return true
    }
    for (const edge of model.edges) {
      if (edge.source !== node.id) {
        continue
      }
      const target = model.nodes.find((candidate) => candidate.id === edge.target)
      if (
        target?.data.kind === 'component' &&
        target.parentId === node.parentId &&
        !isSatisfied(model, target)
      ) {
        return false
      }
    }
    return true
  }

  const readyNodes: C4Node[] = []
  const blockedNodes: C4Node[] = []
  for (const node of workNodes) {
    if (depsSatisfied(node)) {
      readyNodes.push(node)
    } else {
      blockedNodes.push(node)
    }
  }

  if (readyNodes.length === 0 && blockedNodes.length > 0) {
    return ok(
      [
        'Dependency cycle detected. The following nodes all block each other:',
        '',
        ...blockedNodes.map((node) => `  - ${node.data.name} [${node.id}]`),
        '',
        'Fix the model by removing or redirecting edges to break the cycle.'
      ].join('\n'),
      blockedNodes
    )
  }

  const totalTasks = taskNodes.length
  const completedTasks = taskNodes.filter((node) => isSatisfied(model, node)).length

  for (const group of model.groups ?? []) {
    const memberIds = groupMemberIds(group)
    const memberContainers = model.nodes.filter(
      (node) => node.data.kind === 'container' && memberIds.includes(node.id)
    )
    if (memberContainers.length === 0 || memberContainers.length !== memberIds.length) {
      continue
    }
    const scopedToGroup =
      !scopeId ||
      memberContainers.some(
        (node) =>
          node.id === scopeId ||
          isDescendantOf(scopeId, node.id) ||
          isDescendantOf(node.id, scopeId)
      )
    if (!scopedToGroup) {
      continue
    }
    if (!memberContainers.every((node) => node.data.status === 'proposed')) {
      continue
    }

    const lines = [
      '# Setup',
      '',
      `## Scaffold: ${group.name}`,
      '',
      group.description ?? '',
      'Set up the project structure for these containers:',
      '',
      ...memberContainers.flatMap((node) => [
        `- **${node.data.name}** [${node.id}]${node.data.technology ? ` — ${node.data.technology}` : ''}`,
        node.data.description ? `  ${node.data.description}` : ''
      ]),
      !contractIsEmpty(group.contract)
        ? `\n${group.name} — Group Contract (MUST follow):\n${formatContractBlock(group.contract!)}`
        : '',
      ...memberContainers.map((node) =>
        formatContractAndNotes(
          node.data.name,
          mergeContract(ancestorChain(model, node), node),
          collectNotes(ancestorChain(model, node), node)
        )
      ),
      '---',
      TASK_INSTRUCTIONS,
      '',
      'After scaffolding, mark these as implemented with a reason explaining what was scaffolded:',
      '```',
      `update_nodes(nodes: [${memberContainers
        .map(
          (node) =>
            `{node_id: "${node.id}", status: "implemented", reason: "Scaffolded shared runtime"}`
        )
        .join(', ')}])`,
      '```',
      '',
      `---\nProgress: ${completedTasks}/${totalTasks} tasks complete${
        findNextName(blockedNodes, readyNodes, memberContainers)
          ? ` | Next up: ${findNextName(blockedNodes, readyNodes, memberContainers)}`
          : ''
      }`
    ]
      .filter(Boolean)
      .join('\n')

    return ok(lines, memberContainers)
  }

  if (!scopeId) {
    const choosableContainers = model.nodes.filter((node) => {
      if (node.data.kind !== 'container' || !node.data.status || node.data.external) {
        return false
      }
      if (parentIsExternal(node)) {
        return false
      }
      const selfNeedsWork = !isSatisfied(model, node)
      const childrenNeedWork = model.nodes.some(
        (child) =>
          child.parentId === node.id &&
          child.data.status !== undefined &&
          !['implemented', 'verified', 'vagrant'].includes(child.data.status)
      )
      return selfNeedsWork || childrenNeedWork
    })

    if (choosableContainers.length > 1) {
      const lines = [
        `# Task ${completedTasks + 1} of ${totalTasks}`,
        '',
        '## Choose next task',
        '',
        'These containers are ready to build. Pick one and call get_task again with node_id set to that container id.',
        '',
        ...choosableContainers.map((node) => `- **${node.data.name}** [${node.id}]`)
      ]
      return ok(lines.join('\n'), choosableContainers)
    }
  }

  const readyContainers = readyNodes.filter((node) => node.data.kind === 'container')
  const readyComponents = readyNodes.filter((node) => node.data.kind === 'component')
  const workUnit =
    readyContainers.length > 0
      ? readyContainers
      : ((): C4Node[] => {
          const firstParent = readyComponents[0]?.parentId
          const siblings = readyComponents.filter((node) => node.parentId === firstParent)
          const siblingIds = new Set(siblings.map((node) => node.id))
          const hasInterDeps = model.edges.some(
            (edge) => siblingIds.has(edge.source) && siblingIds.has(edge.target)
          )
          if (!hasInterDeps) {
            return siblings
          }
          return siblings
            .filter(
              (node) =>
                !model.edges.some((edge) => edge.source === node.id && siblingIds.has(edge.target))
            )
            .slice(0, 1)
        })()

  if (workUnit.length === 0) {
    return ok('All tasks complete. Nothing to build.')
  }

  const globalTaskNodes = model.nodes.filter((node) => {
    if (!['container', 'component'].includes(node.data.kind) || !node.data.status) {
      return false
    }
    if (parentIsExternal(node)) {
      return false
    }
    return !(node.data.kind === 'container' && hasStatusChildren(model, node))
  })
  const globalCompleted = globalTaskNodes.filter((node) => isSatisfied(model, node)).length
  const taskNum = globalCompleted + 1
  const unitLabel =
    workUnit.length === 1
      ? `Build: ${workUnit[0]!.data.name}`
      : `Build: ${workUnit.map((node) => node.data.name).join(' + ')}`

  const lines = [
    `# Task ${taskNum} of ${globalTaskNodes.length}`,
    '',
    `## ${unitLabel}`,
    '',
    'Build ONLY what this task describes. Do not scaffold or set up other parts of the project.',
    ''
  ]

  for (const node of workUnit) {
    const chain = ancestorChain(model, node)
    const contract = mergeContract(chain, node)
    const notes = collectNotes(chain, node)
    if (workUnit.length > 1) {
      lines.push(`### ${node.data.name} [${node.id}]`)
    } else {
      lines.push(`[${node.id}]`)
    }
    if (node.data.description) {
      lines.push(node.data.description)
    }
    if (node.data.technology) {
      lines.push(`Technology: ${node.data.technology}`)
    }
    lines.push(`Status: ${statusStr(node.data.status)}`)
    if (!contractIsEmpty(contract)) {
      lines.push(
        '\nContract (you MUST follow these requirements):',
        formatContractBlock(contract, '  ')
      )
    }
    if (notes.length > 0) {
      lines.push('\nNotes:', ...notes.map((note) => `  - ${note}`))
    }

    const childKinds: [string, C4Kind][] = [
      ['Processes', 'process'],
      ['Models', 'model'],
      ['Operations', 'operation']
    ]
    for (const [label, kind] of childKinds) {
      const children = model.nodes.filter(
        (child) => child.parentId === node.id && child.data.kind === kind
      )
      if (children.length === 0) {
        continue
      }
      lines.push(`\n${label}:`)
      for (const child of children) {
        lines.push(`  - ${child.data.name} [${child.id}] (${statusStr(child.data.status)})`)
        if (child.data.description) {
          lines.push(`    ${child.data.description}`)
        }
        if (kind === 'model') {
          for (const property of child.data.properties ?? []) {
            lines.push(
              `    .${property.label}${property.description ? ` — ${property.description}` : ''}`
            )
          }
        }
      }
    }

    if ((node.data.sources ?? []).length > 0) {
      lines.push(
        '\nSources:',
        ...(node.data.sources ?? []).map((source) => `  - ${source.pattern} — ${source.comment}`)
      )
    }

    const dependencies = model.edges
      .map((edge) => {
        if (edge.source === node.id) {
          const target = model.nodes.find((candidate) => candidate.id === edge.target)
          return target
            ? `  -> ${target.data.name} "${edge.data?.label ?? ''}" (${kindStr(target.data.kind)})`
            : null
        }
        if (edge.target === node.id) {
          const source = model.nodes.find((candidate) => candidate.id === edge.source)
          return source
            ? `  <- ${source.data.name} "${edge.data?.label ?? ''}" (${kindStr(source.data.kind)})`
            : null
        }
        return null
      })
      .filter((item): item is string => item !== null)
    if (dependencies.length > 0) {
      lines.push('\nDependencies:', ...dependencies)
    }
    lines.push('')
  }

  lines.push('---', TASK_INSTRUCTIONS, '')
  lines.push('After building, mark as implemented with a reason and set source locations:')
  lines.push('```')
  lines.push(
    `update_nodes(nodes: [${workUnit
      .map(
        (node) =>
          `{node_id: "${node.id}", status: "implemented", reason: "Built ${node.data.name}", source: [{pattern: "src/module/file.ts", line: 1, endLine: 50}]}`
      )
      .join(', ')}])`
  )
  lines.push('```')

  const pendingMembers = workUnit.flatMap((node) =>
    node.data.kind === 'component'
      ? model.nodes
          .filter(
            (child) =>
              child.parentId === node.id &&
              ['operation', 'process', 'model'].includes(child.data.kind) &&
              child.data.status === 'proposed'
          )
          .map((child) => ({ child, parentName: node.data.name }))
      : []
  )
  if (pendingMembers.length > 0) {
    lines.push(
      '\nAlso mark these member nodes as implemented with a reason explaining what was built:'
    )
    for (const { child, parentName } of pendingMembers) {
      lines.push(
        `  - ${child.data.name} [${child.id}] (${kindStr(child.data.kind)}, ${statusStr(child.data.status)}) in ${parentName}`
      )
    }
  }

  const nextName = findNextName(blockedNodes, readyNodes, workUnit)
  lines.push(
    `\n---\nProgress: ${globalCompleted}/${globalTaskNodes.length} tasks complete${
      nextName ? ` | Next up: ${nextName}` : ''
    }`
  )

  return ok(lines.join('\n'), workUnit)
}

async function updateNodes(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (!Array.isArray(args.nodes)) {
    return fail('update_nodes requires arguments.nodes')
  }
  if (await isStrictScryerModel(projectPath)) {
    return strictUpdateNodes(projectPath, args.nodes)
  }
  const model = await readModel(projectPath)
  const sourceMap = { ...model.sourceMap }
  const updated: string[] = []
  for (const update of args.nodes) {
    if (!isRecord(update) || typeof update.node_id !== 'string') {
      return fail('Each update_nodes item requires node_id')
    }
    const node = model.nodes.find((candidate) => candidate.id === update.node_id)
    if (!node) {
      return fail(`Node '${update.node_id}' not found`)
    }
    const nextContract = normalizeContract(update.contract)
    if (update.status !== undefined) {
      if (!isStatus(update.status)) {
        return fail(`Node '${update.node_id}' has invalid status '${String(update.status)}'`)
      }
      const reason = asString(update.reason)?.trim() ?? ''
      if (!reason) {
        return fail(`Node '${update.node_id}': reason is required when changing status`)
      }
      if (update.status === 'verified') {
        const unmet = validateVerifiedGate(model, node, nextContract)
        if (unmet.length > 0) {
          return fail(
            `Cannot set '${update.node_id}' to verified. These expect contract items are not yet passed:\n${unmet.join('\n')}`
          )
        }
      }
      node.data.status = update.status
      node.data.statusReason = reason
    }
    const nextName = asString(update.name)
    if (nextName !== undefined) {
      const identifierError =
        node.data.kind === 'operation'
          ? validateIdentifier(nextName, `operation '${node.id}'`)
          : null
      const typeError =
        node.data.kind === 'model' ? validateTypeName(nextName, `model '${node.id}'`) : null
      if (identifierError ?? typeError) {
        return fail((identifierError ?? typeError)!)
      }
      node.data.name = nextName
    }
    const nextDescription = asString(update.description)
    if (nextDescription !== undefined) {
      node.data.description = nextDescription
    }
    const nextTechnology = asString(update.technology)
    if (nextTechnology !== undefined) {
      node.data.technology = nextTechnology
    }
    if (typeof update.external === 'boolean') {
      node.data.external = update.external
    }
    const nextShape = asString(update.shape)
    if (nextShape !== undefined) {
      node.data.shape = nextShape as C4Node['data']['shape']
    }
    const sources = normalizeSources(update.sources)
    if (sources !== undefined) {
      node.data.sources = sources
    }
    if (nextContract !== undefined) {
      node.data.contract = nextContract
    }
    const notes = asStringArray(update.notes)
    if (notes !== undefined) {
      node.data.notes = notes
    }
    const properties = normalizeProperties(update.properties)
    if (properties !== undefined) {
      const error = validatePropertyLabels(properties, `node '${update.node_id}'`)
      if (error) {
        return fail(error)
      }
      node.data.properties = properties
    }
    const locations = normalizeSourceLocations(update.source)
    if (locations !== undefined) {
      if (locations.length === 0) {
        delete sourceMap[node.id]
      } else {
        sourceMap[node.id] = locations
      }
    }
    updated.push(update.node_id)
  }
  model.sourceMap = sourceMap
  const errors = validateModelShape(model)
  if (errors.length > 0) {
    return fail(errors.join('\n'))
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(`Updated ${updated.length} node(s)`, model)
}

async function strictUpdateNodes(
  projectPath: string,
  updates: unknown[]
): Promise<ScryerToolResult> {
  const nodePatches: Record<string, unknown>[] = []
  const sourceEntries: Record<string, unknown>[] = []
  const boundaries: Record<string, unknown>[] = []
  const compatibilityModel = await readMcpCompatibleModel(projectPath)

  for (const update of updates) {
    if (!isRecord(update) || typeof update.node_id !== 'string') {
      return fail('Each update_nodes item requires node_id')
    }
    const node = compatibilityModel.nodes.find((candidate) => candidate.id === update.node_id)
    const appearance: Record<string, unknown> = {}
    const nextContract = normalizeContract(update.contract)

    const patch: Record<string, unknown> = { node_id: update.node_id }
    if (update.status !== undefined) {
      if (!node) {
        return fail(`Node '${update.node_id}' not found`)
      }
      if (!isStatus(update.status)) {
        return fail(`Node '${update.node_id}' has invalid status '${String(update.status)}'`)
      }
      const reason = asString(update.reason)?.trim() ?? ''
      if (!reason) {
        return fail(`Node '${update.node_id}': reason is required when changing status`)
      }
      if (update.status === 'verified') {
        const unmet = validateVerifiedGate(compatibilityModel, node, nextContract)
        if (unmet.length > 0) {
          return fail(
            `Cannot set '${update.node_id}' to verified. These expect contract items are not yet passed:\n${unmet.join('\n')}`
          )
        }
      }
      appearance.status = update.status
      appearance.statusReason = reason
    }
    const nextName = asString(update.name)
    if (nextName !== undefined) {
      patch.name = nextName
    }
    const nextDescription = asString(update.description)
    if (nextDescription !== undefined) {
      patch.description = nextDescription
    }
    const nextTechnology = asString(update.technology)
    if (nextTechnology !== undefined) {
      patch.technology = nextTechnology
    }
    if (typeof update.external === 'boolean') {
      patch.external = update.external
    }
    const nextShape = asString(update.shape)
    if (nextShape !== undefined) {
      appearance.shape = nextShape
    }
    if (nextContract !== undefined) {
      appearance.contract = nextContract
    }
    const notes = asStringArray(update.notes)
    if (notes !== undefined) {
      patch.notes = notes.join('\n')
    }
    const properties = normalizeProperties(update.properties)
    if (properties !== undefined) {
      const error = validatePropertyLabels(properties, `node '${update.node_id}'`)
      if (error) {
        return fail(error)
      }
      patch.properties = properties
    }
    if (Object.keys(appearance).length > 0) {
      patch.appearance = appearance
    }
    if (Object.keys(patch).length > 1) {
      nodePatches.push(patch)
    }

    const locations = normalizeSourceLocations(update.source)
    if (locations !== undefined) {
      sourceEntries.push({ node_id: update.node_id, locations })
    }
    const sources = normalizeSources(update.sources)
    if (sources !== undefined) {
      boundaries.push({ node_id: update.node_id, sources })
    }
  }

  if (nodePatches.length > 0) {
    const nodeResult = await defaultScryerEngine.executeOperation(
      'scryer.node.update',
      { nodes: nodePatches },
      scryerOperationContext(projectPath, `mcp-node-update-${Date.now()}`)
    )
    if (!nodeResult.ok) {
      return fail(nodeResult.error.message, nodeResult.error)
    }
  }

  if (sourceEntries.length > 0 || boundaries.length > 0) {
    const sourceResult = await defaultScryerEngine.executeOperation(
      'scryer.source.update',
      {
        ...(sourceEntries.length > 0 ? { entries: sourceEntries } : {}),
        ...(boundaries.length > 0 ? { boundaries } : {})
      },
      scryerOperationContext(projectPath, `mcp-source-update-${Date.now()}`)
    )
    if (!sourceResult.ok) {
      return fail(sourceResult.error.message, sourceResult.error)
    }
  }

  return ok(`Updated ${updates.length} node(s)`)
}

async function strictAddEdges(projectPath: string, edges: unknown[]): Promise<ScryerToolResult> {
  return executeStrictScryerOperation(
    projectPath,
    'scryer.link.add',
    {
      links: edges.map((edge) => {
        if (!isRecord(edge)) {
          return {}
        }
        return {
          src: edge.source ?? edge.src,
          dst: edge.target ?? edge.dst,
          label: edge.label,
          ...(typeof edge.method === 'string' ? { method: edge.method } : {})
        }
      })
    },
    `Added ${edges.length} edge(s)`
  )
}

async function strictUpdateEdges(projectPath: string, edges: unknown[]): Promise<ScryerToolResult> {
  const unsupportedEndpointPatch = edges.find(
    (edge) => isRecord(edge) && (edge.source !== undefined || edge.target !== undefined)
  )
  if (unsupportedEndpointPatch) {
    return fail('update_edges cannot repoint Scryer 0.3 links; delete and add the link instead')
  }
  return executeStrictScryerOperation(
    projectPath,
    'scryer.link.update',
    {
      links: edges.map((edge) => {
        if (!isRecord(edge)) {
          return {}
        }
        const data = isRecord(edge.data) ? edge.data : {}
        return {
          link_id: edge.edge_id ?? edge.link_id ?? edge.id,
          ...(typeof edge.label === 'string' ? { label: edge.label } : {}),
          ...(typeof data.label === 'string' ? { label: data.label } : {}),
          ...(typeof edge.method === 'string' ? { method: edge.method } : {}),
          ...(typeof data.method === 'string' ? { method: data.method } : {})
        }
      })
    },
    `Updated ${edges.length} edge(s)`
  )
}

async function strictDeleteNodes(
  projectPath: string,
  nodeIds: string[]
): Promise<ScryerToolResult> {
  return executeStrictScryerOperation(
    projectPath,
    'scryer.node.delete',
    { node_ids: nodeIds },
    `Deleted ${nodeIds.length} node(s)`
  )
}

async function strictDeleteEdges(
  projectPath: string,
  linkIds: string[]
): Promise<ScryerToolResult> {
  return executeStrictScryerOperation(
    projectPath,
    'scryer.link.delete',
    { link_ids: linkIds },
    `Deleted ${linkIds.length} edge(s)`
  )
}

async function strictUpdateSourceMap(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (Array.isArray(args.entries)) {
    return executeStrictScryerOperation(
      projectPath,
      'scryer.source.update',
      { entries: args.entries },
      'Updated source map'
    )
  }
  if (isRecord(args.sourceMap)) {
    return executeStrictScryerOperation(
      projectPath,
      'scryer.source.update',
      {
        entries: Object.entries(args.sourceMap).map(([nodeId, locations]) => ({
          node_id: nodeId,
          locations
        }))
      },
      'Updated source map'
    )
  }
  return fail('update_source_map requires entries')
}

async function strictSetGroups(projectPath: string, data: string): Promise<ScryerToolResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    return fail(`Invalid group JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const groups = Array.isArray(parsed) ? parsed : [parsed]
  return executeStrictScryerOperation(
    projectPath,
    'scryer.group.set',
    { data: groups },
    `Set ${groups.length} group(s)`
  )
}

async function strictDeleteGroup(projectPath: string, groupId: string): Promise<ScryerToolResult> {
  return executeStrictScryerOperation(
    projectPath,
    'scryer.group.delete',
    { group_id: groupId },
    `Deleted group '${groupId}'`
  )
}

async function addNodes(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (!Array.isArray(args.nodes)) {
    return fail('add_nodes requires arguments.nodes')
  }
  if (await isStrictScryerModel(projectPath)) {
    return fail('add_nodes is not supported for Scryer 0.3 models; use intent add operations')
  }
  const model = await readModel(projectPath)
  const added: string[] = []
  for (const item of args.nodes) {
    if (!isRecord(item) || typeof item.name !== 'string' || !isKind(item.kind)) {
      return fail('Each add_nodes item requires name and valid kind')
    }
    const kind = item.kind
    const status = isStatus(item.status) && kind !== 'person' ? item.status : undefined
    const node: C4Node = {
      id: nextNodeId(model),
      type: nodeTypeForKind(kind),
      parentId: asString(item.parent_id ?? item.parentId),
      data: {
        name: item.name,
        description: asString(item.description) ?? '',
        kind,
        technology: asString(item.technology),
        external: typeof item.external === 'boolean' ? item.external : undefined,
        shape: asString(item.shape) as C4Node['data']['shape'],
        sources: normalizeSources(item.sources),
        status,
        contract: normalizeContract(item.contract),
        notes: asStringArray(item.notes),
        properties: normalizeProperties(item.properties)
      }
    }
    const parentError = validateParent({ ...model, nodes: [...model.nodes, node] }, node)
    if (parentError) {
      return fail(parentError)
    }
    model.nodes.push(node)
    added.push(node.id)
  }
  const errors = validateModelShape(model)
  if (errors.length > 0) {
    return fail(errors.join('\n'))
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(`Added ${added.length} node(s): ${added.join(', ')}`, model)
}

async function setNode(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  const nodeId = asString(args.node_id ?? args.nodeId)
  if (!nodeId || typeof args.data !== 'string') {
    return fail('set_node requires node_id and JSON string data')
  }
  if (await isStrictScryerModel(projectPath)) {
    return fail('set_node is not supported for Scryer 0.3 models through the compatibility bridge')
  }
  const model = await readModel(projectPath)
  if (!model.nodes.some((node) => node.id === nodeId)) {
    return fail(`Node '${nodeId}' not found`)
  }
  let subtree: { nodes: C4Node[]; edges: C4Edge[] }
  try {
    const parsed = JSON.parse(args.data) as Partial<{ nodes: C4Node[]; edges: C4Edge[] }>
    subtree = { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] }
  } catch (error) {
    return fail(`Invalid subtree JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const oldDescendants = collectDescendantIds(model, nodeId)
  oldDescendants.delete(nodeId)
  model.nodes = model.nodes.filter((node) => !oldDescendants.has(node.id))
  model.edges = model.edges.filter(
    (edge) => !oldDescendants.has(edge.source) && !oldDescendants.has(edge.target)
  )
  cleanupReferences(model, oldDescendants)

  const incomingIds = new Set(subtree.nodes.map((node) => node.id))
  for (const node of subtree.nodes) {
    if (!node.parentId || (node.parentId !== nodeId && !incomingIds.has(node.parentId))) {
      return fail(`Node '${node.id}' must be a descendant of '${nodeId}'`)
    }
    node.type = nodeTypeForKind(node.data.kind)
    delete node.position
  }
  model.nodes.push(...subtree.nodes)
  model.edges.push(...subtree.edges)
  const errors = validateModelShape(model)
  if (errors.length > 0) {
    return fail(errors.join('\n'))
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(
    `Set ${subtree.nodes.length} descendant node(s) and ${subtree.edges.length} edge(s) under '${nodeId}'`,
    model
  )
}

async function addEdges(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (!Array.isArray(args.edges)) {
    return fail('add_edges requires arguments.edges')
  }
  if (await isStrictScryerModel(projectPath)) {
    return strictAddEdges(projectPath, args.edges)
  }
  const model = await readModel(projectPath)
  const nodeIds = new Set(model.nodes.map((node) => node.id))
  const added: string[] = []
  for (const item of args.edges) {
    if (
      !isRecord(item) ||
      typeof item.source !== 'string' ||
      typeof item.target !== 'string' ||
      typeof item.label !== 'string'
    ) {
      return fail('Each add_edges item requires source, target, and label')
    }
    if (!nodeIds.has(item.source)) {
      return fail(`Source node '${item.source}' not found`)
    }
    if (!nodeIds.has(item.target)) {
      return fail(`Target node '${item.target}' not found`)
    }
    if (item.label.length > 30) {
      return fail(`Edge label '${item.label}' exceeds 30 character limit`)
    }
    const id = makeEdgeId(item.source, item.target)
    if (model.edges.some((edge) => edge.id === id)) {
      return fail(`Edge from '${item.source}' to '${item.target}' already exists`)
    }
    model.edges.push({
      id,
      source: item.source,
      target: item.target,
      data: {
        label: item.label,
        ...(typeof item.method === 'string' ? { method: item.method } : {})
      }
    })
    added.push(id)
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(`Added ${added.length} edge(s)`, model)
}

async function updateEdges(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ScryerToolResult> {
  if (!Array.isArray(args.edges)) {
    return fail('update_edges requires arguments.edges')
  }
  if (await isStrictScryerModel(projectPath)) {
    return strictUpdateEdges(projectPath, args.edges)
  }
  const model = await readModel(projectPath)
  const edgeById = new Map(model.edges.map((edge) => [edge.id, edge]))
  for (const input of args.edges) {
    if (!isRecord(input)) {
      return fail('Each update_edges item must be an object')
    }
    const edgeId = asString(input.edge_id ?? input.id)
    if (!edgeId) {
      return fail('Each update_edges item requires edge_id')
    }
    const existing = edgeById.get(edgeId)
    if (input.edge_id && !existing) {
      return fail(`Edge '${edgeId}' not found`)
    }
    const edge: C4Edge = existing
      ? { ...existing, data: { ...(existing.data ?? { label: '' }) } }
      : {
          id: edgeId,
          source: asString(input.source) ?? '',
          target: asString(input.target) ?? '',
          data: { label: '' }
        }
    if (typeof input.label === 'string') {
      edge.data = { ...(edge.data ?? { label: '' }), label: input.label }
    }
    if (typeof input.method === 'string') {
      edge.data = { ...(edge.data ?? { label: '' }), method: input.method }
    }
    if (isRecord(input.data)) {
      edge.data = input.data as C4Edge['data']
    }
    if (typeof input.source === 'string') {
      edge.source = input.source
    }
    if (typeof input.target === 'string') {
      edge.target = input.target
    }
    edgeById.set(edge.id, edge)
  }
  model.edges = [...edgeById.values()]
  const errors = validateModelShape(model)
  if (errors.length > 0) {
    return fail(errors.join('\n'))
  }
  await writeModelAndBaseline(projectPath, model)
  return ok(`Updated ${args.edges.length} edge(s)`, model)
}

function getScopedNode(model: C4ModelData, nodeId: string): unknown {
  const target = model.nodes.find((node) => node.id === nodeId)
  if (!target) {
    return null
  }
  const subtreeIds = collectDescendantIds(model, nodeId)
  const descendants = model.nodes.filter((node) => subtreeIds.has(node.id) && node.id !== nodeId)
  const internalEdges: C4Edge[] = []
  const externalEdges: unknown[] = []
  for (const edge of model.edges) {
    const sourceIn = subtreeIds.has(edge.source)
    const targetIn = subtreeIds.has(edge.target)
    if (sourceIn && targetIn) {
      internalEdges.push(edge)
    } else if (sourceIn || targetIn) {
      const externalNodeId = sourceIn ? edge.target : edge.source
      const externalNode = model.nodes.find((node) => node.id === externalNodeId)
      externalEdges.push({
        ...edge,
        external_node_name: externalNode?.data.name ?? '',
        external_node_kind: externalNode ? kindLabel(externalNode.data.kind) : ''
      })
    }
  }
  const sourceMap = Object.fromEntries(
    Object.entries(model.sourceMap ?? {}).filter(([id]) => subtreeIds.has(id))
  )
  const groups: Group[] = []
  let group = (model.groups ?? []).find((candidate) => candidate.memberIds.includes(nodeId))
  const seen = new Set<string>()
  while (group && !seen.has(group.id)) {
    groups.push(group)
    seen.add(group.id)
    group = group.parentGroupId
      ? (model.groups ?? []).find((candidate) => candidate.id === group!.parentGroupId)
      : undefined
  }
  return {
    node: stripNodeForAgent(target),
    descendants: descendants.map(stripNodeForAgent),
    internal_edges: internalEdges,
    external_edges: externalEdges,
    source_map: sourceMap,
    groups
  }
}

function sortForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCompare)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortForCompare(item)])
  )
}

function stringifyComparable(value: unknown): string {
  return JSON.stringify(sortForCompare(value))
}

function computeDiff(baseline: C4ModelData, current: C4ModelData): string {
  const lines: string[] = []
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, stripNodeForAgent(node)]))
  const currentNodes = new Map(current.nodes.map((node) => [node.id, stripNodeForAgent(node)]))
  const addedNodes = [...currentNodes.entries()].filter(([id]) => !baselineNodes.has(id))
  const removedNodes = [...baselineNodes.entries()].filter(([id]) => !currentNodes.has(id))
  const modifiedNodes = [...currentNodes.entries()].filter(
    ([id, node]) =>
      baselineNodes.has(id) &&
      stringifyComparable(baselineNodes.get(id)) !== stringifyComparable(node)
  )

  if (addedNodes.length > 0) {
    lines.push('Nodes added:', ...addedNodes.map(([, node]) => `- ${node.data.name} (${node.id})`))
  }
  if (removedNodes.length > 0) {
    lines.push(
      'Nodes removed:',
      ...removedNodes.map(([, node]) => `- ${node.data.name} (${node.id})`)
    )
  }
  if (modifiedNodes.length > 0) {
    lines.push(
      'Nodes modified:',
      ...modifiedNodes.map(([, node]) => `- ${node.data.name} (${node.id})`)
    )
  }

  const baselineEdges = new Map(baseline.edges.map((edge) => [edge.id, edge]))
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]))
  const addedEdges = [...currentEdges.keys()].filter((id) => !baselineEdges.has(id))
  const removedEdges = [...baselineEdges.keys()].filter((id) => !currentEdges.has(id))
  const modifiedEdges = [...currentEdges.entries()].filter(
    ([id, edge]) =>
      baselineEdges.has(id) &&
      stringifyComparable(baselineEdges.get(id)) !== stringifyComparable(edge)
  )
  if (addedEdges.length > 0) {
    lines.push('Edges added:', ...addedEdges.map((id) => `- ${id}`))
  }
  if (removedEdges.length > 0) {
    lines.push('Edges removed:', ...removedEdges.map((id) => `- ${id}`))
  }
  if (modifiedEdges.length > 0) {
    lines.push('Edges modified:', ...modifiedEdges.map(([id]) => `- ${id}`))
  }

  if (
    stringifyComparable(baseline.sourceMap ?? {}) !== stringifyComparable(current.sourceMap ?? {})
  ) {
    lines.push('Source map modified')
  }
  if (stringifyComparable(baseline.flows ?? []) !== stringifyComparable(current.flows ?? [])) {
    lines.push('Flows modified')
  }
  if (stringifyComparable(baseline.groups ?? []) !== stringifyComparable(current.groups ?? [])) {
    lines.push('Groups modified')
  }
  return lines.length > 0 ? lines.join('\n') : 'No model changes since baseline.'
}

export async function callScryerTool(
  projectPath: string,
  call: ScryerToolCall
): Promise<ScryerToolResult> {
  switch (call.toolName) {
    case 'list_models': {
      await readModel(projectPath)
      return ok(`* ${getProjectModelPath(projectPath)} (project)`)
    }
    case 'set_model':
      return setModel(projectPath, call.arguments)
    case 'get_model': {
      const model = stripPositions(await readModel(projectPath))
      await writeBaseline(projectPath, model)
      return ok(JSON.stringify(model, null, 2), model)
    }
    case 'get_node': {
      const model = await readModel(projectPath)
      const nodeId = String(call.arguments.node_id ?? call.arguments.nodeId ?? '')
      const scoped = getScopedNode(model, nodeId)
      if (!scoped) {
        return fail(`Node '${nodeId}' not found`)
      }
      await writeBaseline(projectPath, model)
      return ok(JSON.stringify(scoped, null, 2), scoped)
    }
    case 'add_nodes':
      return addNodes(projectPath, call.arguments)
    case 'set_node':
      return setNode(projectPath, call.arguments)
    case 'update_nodes':
      return updateNodes(projectPath, call.arguments)
    case 'delete_nodes': {
      const nodeIds = (Array.isArray(call.arguments.node_ids) ? call.arguments.node_ids : []).map(
        String
      )
      if (await isStrictScryerModel(projectPath)) {
        return strictDeleteNodes(projectPath, nodeIds)
      }
      const ids = new Set(nodeIds)
      const model = await readModel(projectPath)
      const toDelete = new Set<string>()
      for (const id of ids) {
        for (const descendant of collectDescendantIds(model, id)) {
          toDelete.add(descendant)
        }
      }
      const before = model.nodes.length
      model.nodes = model.nodes.filter((node) => !toDelete.has(node.id))
      model.edges = model.edges.filter(
        (edge) => !toDelete.has(edge.source) && !toDelete.has(edge.target)
      )
      cleanupReferences(model, toDelete)
      await writeModelAndBaseline(projectPath, model)
      return ok(`Deleted ${before - model.nodes.length} node(s)`, model)
    }
    case 'add_edges':
      return addEdges(projectPath, call.arguments)
    case 'update_edges':
      return updateEdges(projectPath, call.arguments)
    case 'delete_edges': {
      const edgeIds = (Array.isArray(call.arguments.edge_ids) ? call.arguments.edge_ids : []).map(
        String
      )
      if (await isStrictScryerModel(projectPath)) {
        return strictDeleteEdges(projectPath, edgeIds)
      }
      const ids = new Set(edgeIds)
      const model = await readModel(projectPath)
      const missing = [...ids].filter((id) => !model.edges.some((edge) => edge.id === id))
      if (missing.length > 0) {
        return fail(`Edge '${missing[0]}' not found`)
      }
      model.edges = model.edges.filter((edge) => !ids.has(edge.id))
      await writeModelAndBaseline(projectPath, model)
      return ok(`Deleted ${ids.size} edge(s)`, model)
    }
    case 'update_source_map': {
      if (await isStrictScryerModel(projectPath)) {
        return strictUpdateSourceMap(projectPath, call.arguments)
      }
      const model = await readModel(projectPath)
      const sourceMap = { ...model.sourceMap }
      if (Array.isArray(call.arguments.entries)) {
        for (const entry of call.arguments.entries) {
          if (!isRecord(entry) || typeof entry.node_id !== 'string') {
            return fail('Each update_source_map entry requires node_id')
          }
          const exists =
            model.nodes.some((node) => node.id === entry.node_id) ||
            (model.flows ?? []).some((flow) => flow.id === entry.node_id)
          if (!exists) {
            return fail(`Node or flow '${entry.node_id}' not found`)
          }
          const locations = normalizeSourceLocations(entry.locations) ?? []
          if (locations.length === 0) {
            delete sourceMap[entry.node_id]
          } else {
            sourceMap[entry.node_id] = locations
          }
        }
      } else if (isRecord(call.arguments.sourceMap)) {
        Object.assign(sourceMap, call.arguments.sourceMap as C4ModelData['sourceMap'])
      } else {
        return fail('update_source_map requires entries')
      }
      model.sourceMap = sourceMap
      await writeModelAndBaseline(projectPath, model)
      return ok('Updated source map', model)
    }
    case 'set_flows': {
      if (await isStrictScryerModel(projectPath)) {
        return fail('set_flows is not supported for Scryer 0.3 Architecture models')
      }
      if (typeof call.arguments.data !== 'string') {
        return fail('set_flows requires data')
      }
      let parsed: Flow | Flow[]
      try {
        parsed = JSON.parse(call.arguments.data) as Flow | Flow[]
      } catch (error) {
        return fail(`Invalid flow JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const flows = Array.isArray(parsed) ? parsed : [parsed]
      const model = await readModel(projectPath)
      const next = [...(model.flows ?? [])]
      for (const flow of flows) {
        const index = next.findIndex((candidate) => candidate.id === flow.id)
        if (index === -1) {
          next.push(flow)
        } else {
          next[index] = flow
        }
      }
      model.flows = next
      await writeModelAndBaseline(projectPath, model)
      return ok(`Set ${flows.length} flow(s)`, model)
    }
    case 'delete_flow': {
      if (await isStrictScryerModel(projectPath)) {
        return fail('delete_flow is not supported for Scryer 0.3 Architecture models')
      }
      const flowId = String(call.arguments.flow_id ?? '')
      const model = await readModel(projectPath)
      const before = (model.flows ?? []).length
      model.flows = (model.flows ?? []).filter((flow) => flow.id !== flowId)
      if (model.flows.length === before) {
        return fail(`Flow '${flowId}' not found`)
      }
      delete model.sourceMap?.[flowId]
      await writeModelAndBaseline(projectPath, model)
      return ok(`Deleted flow '${flowId}'`, model)
    }
    case 'set_groups': {
      if (typeof call.arguments.data !== 'string') {
        return fail('set_groups requires data')
      }
      if (await isStrictScryerModel(projectPath)) {
        return strictSetGroups(projectPath, call.arguments.data)
      }
      let parsed: Group | Group[]
      try {
        parsed = JSON.parse(call.arguments.data) as Group | Group[]
      } catch (error) {
        return fail(`Invalid group JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const groups = Array.isArray(parsed) ? parsed : [parsed]
      const model = await readModel(projectPath)
      const nodeIds = new Set(model.nodes.map((node) => node.id))
      for (const group of groups) {
        for (const memberId of group.memberIds) {
          if (!nodeIds.has(memberId)) {
            return fail(`Member '${memberId}' in group '${group.name}' not found in model`)
          }
        }
      }
      const next = [...(model.groups ?? [])]
      for (const group of groups) {
        const memberIds = new Set(group.memberIds)
        for (const existing of next) {
          if (existing.id !== group.id) {
            existing.memberIds = existing.memberIds.filter((id) => !memberIds.has(id))
          }
        }
        const index = next.findIndex((candidate) => candidate.id === group.id)
        if (index === -1) {
          next.push(group)
        } else {
          next[index] = group
        }
      }
      model.groups = next.filter((group) => group.memberIds.length > 0)
      await writeModelAndBaseline(projectPath, model)
      return ok(`Set ${groups.length} group(s)`, model)
    }
    case 'delete_group': {
      const groupId = String(call.arguments.group_id ?? '')
      if (await isStrictScryerModel(projectPath)) {
        return strictDeleteGroup(projectPath, groupId)
      }
      const model = await readModel(projectPath)
      const before = (model.groups ?? []).length
      model.groups = (model.groups ?? []).filter((group) => group.id !== groupId)
      if (model.groups.length === before) {
        return fail(`Group '${groupId}' not found`)
      }
      await writeModelAndBaseline(projectPath, model)
      return ok(`Deleted group '${groupId}'`, model)
    }
    case 'set_implementing': {
      await setImplementing(projectPath, call.arguments.active === true)
      return ok(
        call.arguments.active === true ? 'Drift detection suppressed' : 'Drift detection resumed'
      )
    }
    case 'get_rules':
      return ok(SCRYER_RULES)
    case 'validate_model': {
      const model = await readModel(projectPath)
      const errors = [...validateModelShape(model), ...validateMentionEdges(model)]
      return errors.length === 0 ? ok('Model is valid') : fail(errors.join('\n'))
    }
    case 'get_task':
      return getTask(projectPath, call.arguments)
    case 'get_changes': {
      const baseline = await readBaseline(projectPath)
      if (!baseline) {
        return fail('No baseline found. Call get_model first to establish a reference point.')
      }
      const model = await readModel(projectPath)
      return ok(computeDiff(baseline, model), { baseline, current: model })
    }
    case 'get_structure': {
      const path = String(call.arguments.path ?? projectPath)
      const tree = await projectStructure(path)
      return ok(tree, { tree })
    }
  }
}
