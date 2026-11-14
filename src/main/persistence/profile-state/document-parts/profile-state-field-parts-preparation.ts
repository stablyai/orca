import { PROFILE_STATE_DOCUMENT_VERSION } from '../database/profile-state-database-schema'
import type { PreparedProfileStateDomainPatch } from '../documents/profile-state-domain-patches'
import type { PreparedProfileStateMutation } from '../documents/profile-state-domain-write-validation'
import { hashProfileStatePayload } from '../documents/profile-state-document-validation'
import type {
  ProfileStatePreparedDocumentPart,
  ProfileStateRetainedDocumentParts
} from './profile-state-document-parts-storage'
import {
  assembleProfileStateDomainPayload,
  PROFILE_STATE_SPLIT_DOMAIN_DEPTHS,
  splitProfileStateDomainValue
} from './profile-state-document-parts'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'

type ParentOrder = { children: Set<string>; lastIndex: number; stringKeySeen: boolean }

function parentOrder(): ParentOrder {
  return { children: new Set(), lastIndex: -1, stringKeySeen: false }
}

/** Validate depth-first native object order without parsing any retained payload. */
function canonicalPaths(
  keys: readonly string[],
  existingParts: ProfileStateRetainedDocumentParts,
  depth: number
): (readonly string[])[] | undefined {
  const parents = [parentOrder()]
  const paths: (readonly string[])[] = []
  let previous: readonly string[] | undefined
  for (const key of keys) {
    const path = existingParts.get(key)?.path
    if (
      !Array.isArray(path) ||
      path.length > depth ||
      !path.every((part) => typeof part === 'string') ||
      JSON.stringify(path) !== key
    ) {
      return undefined
    }
    if (path.length === 0) {
      return keys.length === 1 ? [path] : undefined
    }
    let common = 0
    while (
      previous &&
      common < previous.length &&
      common < path.length &&
      previous[common] === path[common]
    ) {
      common++
    }
    if (previous && (common === previous.length || common === path.length)) {
      return undefined
    }
    parents.length = common + 1
    for (let offset = common; offset < path.length; offset++) {
      const parent = parents[offset]!
      const segment = path[offset]!
      if (parent.children.has(segment)) {
        return undefined
      }
      const index = Number(segment)
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < 0xffffffff &&
        String(index) === segment
      ) {
        if (parent.stringKeySeen || index <= parent.lastIndex) {
          return undefined
        }
        parent.lastIndex = index
      } else {
        parent.stringKeySeen = true
      }
      parent.children.add(segment)
      if (offset + 1 < path.length) {
        parents.push(parentOrder())
      }
    }
    paths.push(path)
    previous = path
  }
  return paths
}

/** Verified rows stay within this transaction and feed the ordinary parts SQL writer. */
export function prepareProfileStateFieldParts(
  patch: PreparedProfileStateDomainPatch,
  existingParts: ProfileStateRetainedDocumentParts
): PreparedProfileStateMutation | undefined {
  const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(patch.domain)
  if (depth === undefined) {
    return undefined
  }
  const keys = [...existingParts.keys()]
  const paths = canonicalPaths(keys, existingParts, depth)
  if (!paths) {
    return undefined
  }
  const parts: ProfileStatePreparedDocumentPart[] = [...existingParts.values()]
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
      const index = indices[offset]!
      parts[index] = { ...part, ordinal: parts[index]!.ordinal }
    })
  }
  const payload = assembleProfileStateDomainPayload(parts, paths)
  return {
    domain: patch.domain,
    domainVersion: PROFILE_STATE_DOCUMENT_VERSION,
    payload,
    payloadHash: hashProfileStatePayload(payload),
    existingParts,
    preparedParts: parts
  }
}
