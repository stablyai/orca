import { PROFILE_STATE_DOCUMENT_VERSION } from '../database/profile-state-database-schema'
import type { PreparedProfileStateDomainPatch } from '../documents/profile-state-domain-patches'
import type { PreparedProfileStateMutation } from '../documents/profile-state-domain-write-validation'
import { hashProfileStatePayload } from '../documents/profile-state-document-validation'
import type { ProfileStateExistingDocumentParts } from './profile-state-document-parts-storage'
import {
  assembleProfileStateDomainPayload,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS,
  splitProfileStateDomainValue
} from './profile-state-document-parts'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'

type PathNode = { leaf?: string; children: Map<string, PathNode> }

/** Validate depth-first native object order without parsing any retained payload. */
function canonicalPaths(keys: readonly string[], depth: number): string[][] | undefined {
  const root: PathNode = { children: new Map() }
  const paths: string[][] = []
  for (const key of keys) {
    const path: unknown = JSON.parse(key)
    if (
      !Array.isArray(path) ||
      path.length > depth ||
      !path.every((part) => typeof part === 'string') ||
      JSON.stringify(path) !== key
    ) {
      return undefined
    }
    let node = root
    for (const part of path) {
      if (node.leaf !== undefined) {
        return undefined
      }
      let child = node.children.get(part)
      if (!child) {
        child = { children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
    if (node.leaf !== undefined || node.children.size) {
      return undefined
    }
    node.leaf = key
    paths.push(path)
  }
  const ordered: string[] = []
  const visit = (node: PathNode): void => {
    if (node.leaf !== undefined) {
      ordered.push(node.leaf)
    }
    for (const key of Object.keys(
      Object.fromEntries([...node.children.keys()].map((key) => [key, null]))
    )) {
      visit(node.children.get(key)!)
    }
  }
  visit(root)
  return ordered.every((key, index) => key === keys[index]) ? paths : undefined
}

/** Verified rows stay within this transaction and feed the ordinary parts SQL writer. */
export function prepareProfileStateFieldParts(
  patch: PreparedProfileStateDomainPatch,
  existingParts: ProfileStateExistingDocumentParts
): PreparedProfileStateMutation | undefined {
  const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(patch.domain)
  if (depth === undefined) {
    return undefined
  }
  const keys = [...existingParts.keys()]
  const paths = canonicalPaths(keys, depth)
  if (!paths) {
    return undefined
  }
  const parts = [...existingParts].map(([key, part]) => ({
    key,
    payload: part.payload!,
    contentHash: part.contentHash
  }))
  if (parts.some((part) => part.payload === undefined)) {
    return undefined
  }
  const fieldDepth =
    patch.domain === WORKSPACE_SESSION_DOMAINS[0]
      ? 1
      : patch.domain === WORKSPACE_SESSION_DOMAINS[1]
        ? 2
        : 0
  for (const operation of patch.operations) {
    if (
      operation.kind !== 'set' ||
      operation.path.length === 0 ||
      (operation.path.length !== depth &&
        (fieldDepth === 0 || operation.path.length !== fieldDepth))
    ) {
      return undefined
    }
    const indices: number[] = []
    paths.forEach((path, index) => {
      if (operation.path.every((key, offset) => key === path[offset])) {
        indices.push(index)
      }
    })
    if (!indices.length || indices.at(-1)! - indices[0]! + 1 !== indices.length) {
      return undefined
    }
    const replacement = splitProfileStateDomainValue(
      operation.value,
      depth - operation.path.length
    ).map((part) => ({
      key: JSON.stringify([...operation.path, ...JSON.parse(part.key)]),
      payload: part.payload,
      contentHash: hashProfileStatePayload(part.payload)
    }))
    if (
      replacement.length !== indices.length ||
      replacement.some((part, offset) => part.key !== keys[indices[offset]!])
    ) {
      return undefined
    }
    replacement.forEach((part, offset) => {
      parts[indices[offset]!] = part
    })
  }
  const payload = assembleProfileStateDomainPayload(parts)
  return {
    domain: patch.domain,
    domainVersion: PROFILE_STATE_DOCUMENT_VERSION,
    payload,
    payloadHash: hashProfileStatePayload(payload),
    existingParts,
    preparedParts: parts
  }
}
