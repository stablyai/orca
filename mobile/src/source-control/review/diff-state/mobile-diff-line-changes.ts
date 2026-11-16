import { diffArrays, type ArrayChange } from 'diff'
import { findMobileDiffLineAnchors } from './mobile-diff-line-anchors'

export type MobileDiffChange = Pick<ArrayChange<string>, 'count' | 'added' | 'removed'>

// Limit edit-search cost for large rewrites.
const MAX_EDIT_LENGTH = 250

export function* buildMobileDiffChanges(
  originalKeys: string[],
  modifiedKeys: string[]
): Generator<MobileDiffChange> {
  const changes = diffArrays(originalKeys, modifiedKeys, { maxEditLength: MAX_EDIT_LENGTH })
  if (changes) {
    yield* changes
    return
  }
  const anchors = findMobileDiffLineAnchors(originalKeys, modifiedKeys)
  if (anchors.length === 0) {
    yield* buildPrefixSuffixChanges(originalKeys, modifiedKeys)
    return
  }
  anchors.push({ originalIndex: originalKeys.length, modifiedIndex: modifiedKeys.length })
  let originalStart = 0
  let modifiedStart = 0
  for (const { originalIndex, modifiedIndex } of anchors) {
    if (originalStart < originalIndex || modifiedStart < modifiedIndex) {
      const originalSection = originalKeys.slice(originalStart, originalIndex)
      const modifiedSection = modifiedKeys.slice(modifiedStart, modifiedIndex)
      yield* (
        diffArrays(originalSection, modifiedSection, { maxEditLength: MAX_EDIT_LENGTH }) ??
          buildPrefixSuffixChanges(originalSection, modifiedSection)
      )
    }
    if (originalIndex < originalKeys.length) {
      yield { count: 1, added: false, removed: false }
    }
    originalStart = originalIndex + 1
    modifiedStart = modifiedIndex + 1
  }
}

function* buildPrefixSuffixChanges(
  originalKeys: string[],
  modifiedKeys: string[]
): Generator<MobileDiffChange> {
  let prefix = 0
  while (
    prefix < originalKeys.length &&
    prefix < modifiedKeys.length &&
    originalKeys[prefix] === modifiedKeys[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix + prefix < originalKeys.length &&
    suffix + prefix < modifiedKeys.length &&
    originalKeys[originalKeys.length - suffix - 1] ===
      modifiedKeys[modifiedKeys.length - suffix - 1]
  ) {
    suffix += 1
  }
  const removed = originalKeys.length - prefix - suffix
  const added = modifiedKeys.length - prefix - suffix
  if (prefix > 0) {
    yield { count: prefix, added: false, removed: false }
  }
  if (removed > 0) {
    yield { count: removed, added: false, removed: true }
  }
  if (added > 0) {
    yield { count: added, added: true, removed: false }
  }
  if (suffix > 0) {
    yield { count: suffix, added: false, removed: false }
  }
}
