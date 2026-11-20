import { isDescendantOrEqualAsync } from '../../../filesystem/local-file-io/filesystem-path-containment'

export function createRegisteredRootScan(roots: Iterable<string>) {
  let iterator = roots[Symbol.iterator]()
  let pinned = false
  return {
    next: () => iterator.next(),
    pin: () => {
      if (pinned) {
        return
      }
      const remaining: string[] = []
      for (let item = iterator.next(); !item.done; item = iterator.next()) {
        remaining.push(item.value)
      }
      iterator = remaining.values()
      pinned = true
    }
  }
}

export async function findRegisteredWorktreeRootAsync(
  targetPath: string,
  registeredWorktreeRoots: Iterable<string>
): Promise<string | null> {
  let bestRoot: string | null = null
  const roots = createRegisteredRootScan(registeredWorktreeRoots)
  for (let item = roots.next(); !item.done; item = roots.next()) {
    const root = item.value
    const contained = isDescendantOrEqualAsync(targetPath, root)
    if (typeof contained !== 'boolean') {
      roots.pin()
    }
    if (
      (typeof contained === 'boolean' ? contained : await contained) &&
      (!bestRoot || root.length > bestRoot.length)
    ) {
      bestRoot = root
    }
  }
  return bestRoot
}
