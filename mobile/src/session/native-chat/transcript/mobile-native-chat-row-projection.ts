import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../src/shared/native-chat-types'
import type { MobileNativeChatRowContentProps } from './MobileNativeChatRowItemSource'

type Fields = Readonly<Record<string, unknown>>
function sameFields(
  a: Fields,
  b: Fields,
  equal = (_key: string, x: unknown, y: unknown) => Object.is(x, y)
): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(key, a[key], b[key]))
  )
}
function sameSequence<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
  equal: (a: T, b: T) => boolean
): boolean {
  return (
    a === b ||
    (!!a && !!b && a.length === b.length && a.every((value, index) => equal(value, b[index]!)))
  )
}
function sameBlock(a: NativeChatBlock, b: NativeChatBlock): boolean {
  // Fetch/recovery keys, including full-output result bodies, are identity-only.
  return (
    a === b ||
    (a.type === b.type && (a.type === 'text' || a.type === 'image-ref') && sameFields(a, b))
  )
}
function sameMessage(a: NativeChatMessage, b: NativeChatMessage): boolean {
  return (
    a === b ||
    sameFields(a, b, (key, x, y) =>
      key === 'blocks' ? sameSequence(a.blocks, b.blocks, sameBlock) : Object.is(x, y)
    )
  )
}
export function equalMobileNativeChatRowContent(
  a: MobileNativeChatRowContentProps,
  b: MobileNativeChatRowContentProps
): boolean {
  return sameFields(a, b, (key, x, y) => {
    if (Object.is(x, y)) {
      return true
    }
    if (key === 'message') {
      return sameMessage(a.message, b.message)
    }
    if (key === 'workRun') {
      return sameSequence(a.workRun, b.workRun, sameMessage)
    }
    if (key === 'turnStatus') {
      return !!a.turnStatus && !!b.turnStatus && sameFields(a.turnStatus, b.turnStatus)
    }
    if (key === 'source' && a.source && b.source) {
      return sameFields(a.source, b.source, (field, left, right) =>
        field === 'details'
          ? sameSequence(a.source!.details, b.source!.details, (before, after) =>
              sameFields(before, after)
            )
          : Object.is(left, right)
      )
    }
    return false
  })
}
