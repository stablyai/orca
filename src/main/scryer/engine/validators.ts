/* eslint-disable max-lines -- Why: shared Scryer validation rules and finding helpers live together so operation files do not invent one-off validators. */
import type { ScryKind, ScryModel, ScryNode } from './model'
import type { ScryerValidationFinding, ScryerValidatorSet } from './types'
import { semanticPath } from './semantic-paths'

const DESCRIPTION_MAX_CHARS = 500

function isScryKind(value: unknown): value is ScryKind {
  return (
    value === 'person' ||
    value === 'system' ||
    value === 'container' ||
    value === 'component' ||
    value === 'symbol'
  )
}

function validParentKind(parent: ScryKind, child: ScryKind): boolean {
  return (
    (parent === 'system' && child === 'container') ||
    (parent === 'container' && child === 'component') ||
    (parent === 'component' && child === 'symbol')
  )
}

function finding(args: ScryerValidationFinding): ScryerValidationFinding {
  return args
}

function pushFinding(findings: ScryerValidationFinding[], item: ScryerValidationFinding): void {
  findings.push(item)
}

function parentOf(model: ScryModel, id: string): string | undefined {
  return model.nodes.find((node) => node.id === id)?.parentId
}

function nodeById(model: ScryModel): Map<string, ScryNode> {
  return new Map(model.nodes.map((node) => [node.id, node]))
}

function depth(model: ScryModel, id: string): number {
  let current = id
  let count = 0
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parentOf(model, current)
    if (!parent) {
      return count
    }
    current = parent
    count += 1
  }
  return count
}

function isAncestor(model: ScryModel, ancestor: string, descendant: string): boolean {
  let current = parentOf(model, descendant)
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === ancestor) {
      return true
    }
    seen.add(current)
    current = parentOf(model, current)
  }
  return false
}

function linkedEither(model: ScryModel, left: string, right: string): boolean {
  return model.links.some(
    (link) => (link.src === left && link.dst === right) || (link.src === right && link.dst === left)
  )
}

function nodeName(model: ScryModel, id: string): string {
  return model.nodes.find((node) => node.id === id)?.name ?? id
}

export type LinkViolation =
  | { reason: 'self_link' }
  | { reason: 'ancestor_descendant'; ancestor: string; descendant: string }
  | { reason: 'same_level_reference' }
  | { reason: 'duplicate_link'; linkId?: string }

export function linkViolation(model: ScryModel, src: string, dst: string): LinkViolation | null {
  if (src === dst) {
    return { reason: 'self_link' }
  }
  const duplicate = model.links.find((link) => link.src === src && link.dst === dst)
  if (duplicate) {
    return { reason: 'duplicate_link', linkId: duplicate.id }
  }
  if (isAncestor(model, src, dst)) {
    return { reason: 'ancestor_descendant', ancestor: src, descendant: dst }
  }
  if (isAncestor(model, dst, src)) {
    return { reason: 'ancestor_descendant', ancestor: dst, descendant: src }
  }
  if (parentOf(model, src) === parentOf(model, dst)) {
    return null
  }
  const srcDepth = depth(model, src)
  const dstDepth = depth(model, dst)
  if (srcDepth === dstDepth) {
    return { reason: 'same_level_reference' }
  }
  const deeper = srcDepth > dstDepth ? src : dst
  const other = srcDepth > dstDepth ? dst : src
  const parent = parentOf(model, deeper)
  if (!parent) {
    return null
  }
  if (!linkedEither(model, parent, other)) {
    return { reason: 'same_level_reference' }
  }
  return linkViolation(model, parent, other)
}

export function describeLinkViolation(
  model: ScryModel,
  src: string,
  dst: string,
  violation: LinkViolation
): string {
  switch (violation.reason) {
    case 'self_link':
      return `Link ${src}->${dst} rejected because an element cannot link to itself.`
    case 'duplicate_link':
      return `Link ${src}->${dst} rejected because that endpoint pair already exists.`
    case 'ancestor_descendant':
      return `Link ${src}->${dst} rejected: '${nodeName(model, violation.ancestor)}' contains '${nodeName(
        model,
        violation.descendant
      )}'.`
    case 'same_level_reference':
      return `Link ${src}->${dst} rejected because the endpoints are not visible from the same Scryer view surface.`
  }
}

function validateNodeIds(model: ScryModel, findings: ScryerValidationFinding[]): void {
  const seen = new Set<string>()
  for (const node of model.nodes) {
    if (seen.has(node.id)) {
      pushFinding(
        findings,
        finding({
          code: 'duplicate_id',
          severity: 'warning',
          message: `Duplicate node id '${node.id}'`,
          path: semanticPath.node(node.id),
          details: { entity: 'node', id: node.id }
        })
      )
    }
    seen.add(node.id)
  }
}

function validateNodeHierarchy(model: ScryModel, findings: ScryerValidationFinding[]): void {
  const nodes = nodeById(model)
  for (const node of model.nodes) {
    if (!isScryKind(node.kind)) {
      pushFinding(findings, {
        code: 'invalid_hierarchy',
        severity: 'warning',
        message: `Node ${node.id} has invalid kind '${String(node.kind)}'`,
        path: semanticPath.node(node.id, 'kind'),
        details: { nodeId: node.id, reason: 'top_level_kind' }
      })
      continue
    }
    if (node.external === true && node.kind !== 'person' && node.kind !== 'system') {
      pushFinding(findings, {
        code: 'invalid_external',
        severity: 'warning',
        message: `Node ${node.id} cannot be external as kind '${node.kind}'`,
        path: semanticPath.node(node.id, 'external'),
        details: { nodeId: node.id, kind: node.kind }
      })
    }
    if (node.parentId) {
      const parent = nodes.get(node.parentId)
      if (!parent) {
        pushFinding(findings, {
          code: 'missing_reference',
          severity: 'warning',
          message: `Node ${node.id} references missing parent '${node.parentId}'`,
          path: semanticPath.node(node.id, 'parentId'),
          details: { entity: 'node', id: node.parentId, field: 'parentId', targetEntity: 'node' }
        })
      } else if (!validParentKind(parent.kind, node.kind)) {
        pushFinding(findings, {
          code: 'invalid_hierarchy',
          severity: 'warning',
          message: `Node ${node.id} kind '${node.kind}' cannot have parent kind '${parent.kind}'`,
          path: semanticPath.node(node.id, 'parentId'),
          details: { nodeId: node.id, parentId: parent.id, reason: 'invalid_parent_kind' }
        })
      } else if (parent.external === true) {
        pushFinding(findings, {
          code: 'invalid_hierarchy',
          severity: 'warning',
          message: `Node ${node.id} is under external parent '${parent.id}'`,
          path: semanticPath.node(node.id, 'parentId'),
          details: { nodeId: node.id, parentId: parent.id, reason: 'external_parent' }
        })
      }
    } else if (node.kind !== 'person' && node.kind !== 'system') {
      pushFinding(findings, {
        code: 'invalid_hierarchy',
        severity: 'warning',
        message: `Node ${node.id} of kind '${node.kind}' cannot be top-level`,
        path: semanticPath.node(node.id, 'parentId'),
        details: { nodeId: node.id, reason: 'top_level_kind' }
      })
    }
  }
}

function validateText(model: ScryModel, findings: ScryerValidationFinding[]): void {
  for (const node of model.nodes) {
    if ((node.description?.length ?? 0) > DESCRIPTION_MAX_CHARS) {
      pushFinding(findings, {
        code: 'description_too_long',
        severity: 'warning',
        message: `Node ${node.id} description is too long`,
        path: semanticPath.node(node.id, 'description'),
        details: {
          entity: 'node',
          id: node.id,
          max: DESCRIPTION_MAX_CHARS,
          actual: node.description?.length ?? 0
        }
      })
    }
    for (const responsibility of node.responsibilities ?? []) {
      if (responsibility.statement.trim().length === 0) {
        pushFinding(findings, {
          code: 'empty_responsibility',
          severity: 'warning',
          message: `Responsibility ${responsibility.id} has an empty statement`,
          path: semanticPath.nodeResponsibility(node.id, responsibility.id, 'statement'),
          details: { responsibilityId: responsibility.id, ownerId: node.id }
        })
      }
    }
    if (node.kind === 'symbol') {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.name)) {
        pushFinding(findings, {
          code: 'invalid_symbol_name',
          severity: 'warning',
          message: `Symbol ${node.id} has invalid name '${node.name}'`,
          path: semanticPath.node(node.id, 'name'),
          details: { nodeId: node.id, name: node.name }
        })
      }
      if (
        (node.responsibilities ?? []).length === 0 &&
        (node.properties ?? []).length === 0 &&
        node.visual !== true
      ) {
        pushFinding(findings, {
          code: 'empty_symbol',
          severity: 'warning',
          message: `Symbol ${node.id} has no responsibilities, properties, or visual appearance`,
          path: semanticPath.node(node.id),
          details: { nodeId: node.id }
        })
      }
    }
  }
}

function validateLinks(model: ScryModel, findings: ScryerValidationFinding[]): void {
  const nodes = nodeById(model)
  const seenIds = new Set<string>()
  const seenPairs = new Set<string>()
  for (const link of model.links) {
    if (seenIds.has(link.id)) {
      pushFinding(findings, {
        code: 'duplicate_id',
        severity: 'warning',
        message: `Duplicate link id '${link.id}'`,
        path: semanticPath.link(link.id),
        details: { entity: 'link', id: link.id }
      })
    }
    seenIds.add(link.id)
    if (!nodes.has(link.src)) {
      pushFinding(findings, {
        code: 'missing_reference',
        severity: 'warning',
        message: `Link ${link.id} references missing src '${link.src}'`,
        path: semanticPath.link(link.id, 'src'),
        details: { entity: 'link', id: link.id, field: 'src', targetEntity: 'node' }
      })
    }
    if (!nodes.has(link.dst)) {
      pushFinding(findings, {
        code: 'missing_reference',
        severity: 'warning',
        message: `Link ${link.id} references missing dst '${link.dst}'`,
        path: semanticPath.link(link.id, 'dst'),
        details: { entity: 'link', id: link.id, field: 'dst', targetEntity: 'node' }
      })
    }
    const pair = `${link.src}->${link.dst}`
    if (seenPairs.has(pair)) {
      pushFinding(findings, {
        code: 'illegal_link',
        severity: 'warning',
        message: `Duplicate link endpoints ${pair}`,
        path: semanticPath.link(link.id),
        details: { reason: 'duplicate_link', src: link.src, dst: link.dst, linkId: link.id }
      })
    }
    seenPairs.add(pair)
    if (nodes.has(link.src) && nodes.has(link.dst)) {
      const violation = linkViolation(
        { ...model, links: model.links.filter((candidate) => candidate.id !== link.id) },
        link.src,
        link.dst
      )
      if (violation) {
        pushFinding(findings, {
          code: 'illegal_link',
          severity: 'warning',
          message: describeLinkViolation(model, link.src, link.dst, violation),
          path: semanticPath.link(link.id),
          details: {
            reason: violation.reason,
            src: link.src,
            dst: link.dst,
            ...(violation.reason === 'duplicate_link' && violation.linkId
              ? { linkId: violation.linkId }
              : {})
          }
        })
      }
    }
  }
}

function validateGroups(model: ScryModel, findings: ScryerValidationFinding[]): void {
  const nodes = nodeById(model)
  const groups = new Map(model.groups.map((group) => [group.id, group]))
  const seenIds = new Set<string>()
  for (const group of model.groups) {
    if (seenIds.has(group.id)) {
      pushFinding(findings, {
        code: 'invalid_group',
        severity: 'warning',
        message: `Duplicate group id '${group.id}'`,
        path: semanticPath.group(group.id),
        details: { groupId: group.id, reason: 'duplicate_group_id' }
      })
    }
    seenIds.add(group.id)
    if (group.memberIds.length === 0) {
      pushFinding(findings, {
        code: 'invalid_group',
        severity: 'warning',
        message: `Group ${group.id} has no members`,
        path: semanticPath.group(group.id, 'memberIds'),
        details: { groupId: group.id, reason: 'empty_members' }
      })
    }
    if (group.parentGroupId && !groups.has(group.parentGroupId)) {
      pushFinding(findings, {
        code: 'invalid_group',
        severity: 'warning',
        message: `Group ${group.id} references missing parent group '${group.parentGroupId}'`,
        path: semanticPath.group(group.id, 'parentGroupId'),
        details: { groupId: group.id, reason: 'missing_parent' }
      })
    }
    const kinds = new Set<ScryKind>()
    for (const memberId of group.memberIds) {
      const member = nodes.get(memberId)
      if (!member) {
        pushFinding(findings, {
          code: 'invalid_group',
          severity: 'warning',
          message: `Group ${group.id} references missing member '${memberId}'`,
          path: semanticPath.group(group.id, 'memberIds'),
          details: { groupId: group.id, reason: 'missing_member', memberId }
        })
        continue
      }
      kinds.add(member.kind)
      if (group.parentNodeId && member.parentId !== group.parentNodeId) {
        pushFinding(findings, {
          code: 'invalid_group',
          severity: 'warning',
          message: `Group ${group.id} member '${memberId}' is outside parent node '${group.parentNodeId}'`,
          path: semanticPath.group(group.id, 'memberIds'),
          details: { groupId: group.id, reason: 'member_outside_parent', memberId }
        })
      }
    }
    if (kinds.size > 1) {
      pushFinding(findings, {
        code: 'invalid_group',
        severity: 'warning',
        message: `Group ${group.id} mixes member kinds`,
        path: semanticPath.group(group.id, 'memberIds'),
        details: { groupId: group.id, reason: 'mixed_member_kinds' }
      })
    }
  }
}

function responsibilityIds(model: ScryModel): Set<string> {
  const ids = new Set<string>()
  for (const host of [...model.nodes, ...model.groups]) {
    for (const responsibility of host.responsibilities ?? []) {
      ids.add(responsibility.id)
    }
  }
  return ids
}

function validateSourceMap(model: ScryModel, findings: ScryerValidationFinding[]): void {
  const nodes = nodeById(model)
  const responsibilities = responsibilityIds(model)
  for (const key of Object.keys(model.sourceMap)) {
    if (!nodes.has(key) && !responsibilities.has(key)) {
      pushFinding(findings, {
        code: 'unknown_source_map_target',
        severity: 'warning',
        message: `sourceMap key '${key}' does not target a known node or responsibility`,
        path: semanticPath.sourceMapRaw(key),
        details: { key, expected: 'responsibility_or_property_node' }
      })
    }
  }
  for (const key of Object.keys(model.boundaries)) {
    if (!nodes.has(key)) {
      pushFinding(findings, {
        code: 'unknown_boundary_target',
        severity: 'warning',
        message: `boundary key '${key}' does not target a known node`,
        path: semanticPath.boundaryNode(key),
        details: { nodeId: key }
      })
    }
  }
}

function validateDisconnected(model: ScryModel, findings: ScryerValidationFinding[]): void {
  if (model.nodes.length < 2) {
    return
  }
  const linked = new Set<string>()
  for (const link of model.links) {
    linked.add(link.src)
    linked.add(link.dst)
  }
  for (const node of model.nodes) {
    const hasChildren = model.nodes.some((candidate) => candidate.parentId === node.id)
    if (node.parentId || node.kind === 'person' || linked.has(node.id) || hasChildren) {
      continue
    }
    pushFinding(findings, {
      code: 'disconnected_node',
      severity: 'warning',
      message: `Top-level node ${node.id} is disconnected`,
      path: semanticPath.node(node.id),
      details: { nodeId: node.id, view: 'system' }
    })
  }
}

export function validateModelStructure(model: ScryModel): ScryerValidationFinding[] {
  const findings: ScryerValidationFinding[] = []
  validateNodeIds(model, findings)
  validateNodeHierarchy(model, findings)
  validateText(model, findings)
  validateLinks(model, findings)
  validateGroups(model, findings)
  validateSourceMap(model, findings)
  validateDisconnected(model, findings)
  return findings
}

export function coverageGapFinding(directory: string, manifest: string): ScryerValidationFinding {
  return {
    code: 'coverage_gap',
    severity: 'warning',
    message: `Manifest directory ${directory} has no Scryer source coverage`,
    path: semanticPath.model(),
    details: { directory, manifest }
  }
}

export function coverageOverlapFinding(
  directory: string,
  containerIds: string[]
): ScryerValidationFinding {
  return {
    code: 'coverage_overlap',
    severity: 'warning',
    message: `Source directory ${directory} is mapped to multiple containers`,
    path: semanticPath.model(),
    details: { directory, containerIds }
  }
}

export function anchorRangeWarningFinding(args: {
  responsibilityId: string
  pattern: string
  symbol?: string
}): ScryerValidationFinding {
  return {
    code: 'anchor_range_warning',
    severity: 'warning',
    message: `Responsibility ${args.responsibilityId} uses a broad source range`,
    path: semanticPath.sourceMapResponsibility(args.responsibilityId),
    details: {
      responsibilityId: args.responsibilityId,
      pattern: args.pattern,
      ...(args.symbol ? { symbol: args.symbol } : {})
    }
  }
}

export function invalidDriftMarkerTransitionFinding(args: {
  entity: 'node' | 'responsibility' | 'property'
  id: string
  reason: 'vagrant_move' | 'missing_verdict' | 'stale_fold_without_target'
}): ScryerValidationFinding {
  return {
    code: 'invalid_drift_marker_transition',
    severity: 'error',
    message: `Invalid drift marker transition for ${args.entity} ${args.id}`,
    path: args.entity === 'node' ? semanticPath.node(args.id) : semanticPath.model(),
    details: { entity: args.entity, id: args.id, reason: args.reason }
  }
}

export function createScryerValidatorSet(): ScryerValidatorSet {
  return {
    validateModel: validateModelStructure,
    linkViolation(model, src, dst) {
      const violation = linkViolation(model, src, dst)
      if (!violation) {
        return null
      }
      return { reason: violation.reason }
    }
  }
}
