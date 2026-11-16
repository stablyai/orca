import { diffArrays, type ArrayChange } from 'diff'
import { findMobileDiffLineAnchors } from './mobile-diff-line-anchors'

export type MobileDiffChange = Pick<ArrayChange<string>, 'count' | 'added' | 'removed'>

// Limit edit-search cost for large rewrites.
const MAX_EDIT_LENGTH = 250
// Why: a failed section search costs about as much as a failed whole-file one, so sections share a budget.
const MAX_ANCHORED_EDIT_LENGTH = 10 * MAX_EDIT_LENGTH

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
  let editBudget = MAX_ANCHORED_EDIT_LENGTH
  for (const { originalIndex, modifiedIndex } of anchors) {
    if (originalStart < originalIndex || modifiedStart < modifiedIndex) {
      const originalSection = originalKeys.slice(originalStart, originalIndex)
      const modifiedSection = modifiedKeys.slice(modifiedStart, modifiedIndex)
      // One-sided sections are already exact as prefix/suffix, so they spend no budget.
      const maxEditLength =
        originalSection.length > 0 && modifiedSection.length > 0
          ? Math.min(MAX_EDIT_LENGTH, editBudget)
          : 0
      const sectionChanges =
        maxEditLength > 0
          ? diffArrays(originalSection, modifiedSection, { maxEditLength })
          : undefined
      editBudget -= sectionChanges ? countEdits(sectionChanges) : maxEditLength
      yield* sectionChanges ?? buildPrefixSuffixChanges(originalSection, modifiedSection)
    }
    if (originalIndex < originalKeys.length) {
      yield { count: 1, added: false, removed: false }
    }
    originalStart = originalIndex + 1
    modifiedStart = modifiedIndex + 1
  }
}

function countEdits(changes: readonly MobileDiffChange[]): number {
  let edits = 0
  for (const change of changes) {
    if (change.added || change.removed) {
      edits += change.count
    }
  }
  return edits
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
