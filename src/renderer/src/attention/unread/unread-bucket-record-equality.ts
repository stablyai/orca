/** Compare projected bucket fields in place; subscribers needing only equality avoid allocating a projected record on every store write. */
export function sameBucketRecords<T>(
  previous: Readonly<Record<string, readonly T[]>>,
  next: Readonly<Record<string, readonly T[]>>,
  isSameItem: (previous: T, next: T) => boolean
): boolean {
  if (previous === next) {
    return true
  }
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(previous).length) {
    return false
  }
  for (const key of keys) {
    const nextItems = next[key]
    const previousItems = previous[key]
    if (previousItems === nextItems) {
      continue
    }
    if (!previousItems || !nextItems || previousItems.length !== nextItems.length) {
      return false
    }
    for (let index = 0; index < nextItems.length; index += 1) {
      const previousItem = previousItems[index]
      const nextItem = nextItems[index]
      if (
        previousItem === undefined ||
        nextItem === undefined ||
        !isSameItem(previousItem, nextItem)
      ) {
        return false
      }
    }
  }
  return true
}
