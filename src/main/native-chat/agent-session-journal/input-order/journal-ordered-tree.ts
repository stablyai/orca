/** One node of a balanced (AVL) search tree; a tree may cache aggregates on its nodes. */
export type OrderedTreeNode<T, N> = { value: T; height: number; left?: N; right?: N }

/** How one tree orders its values, makes a node and recomputes a node's cached aggregates. */
export type OrderedTree<T, N extends OrderedTreeNode<T, N>> = {
  compare: (a: T, b: T) => number
  create: (value: T) => N
  refresh?: (node: N) => void
}

const height = <T, N extends OrderedTreeNode<T, N>>(node?: N) => node?.height ?? 0

function update<T, N extends OrderedTreeNode<T, N>>(tree: OrderedTree<T, N>, node: N): N {
  node.height = 1 + Math.max(height(node.left), height(node.right))
  tree.refresh?.(node)
  return node
}

function rotateLeft<T, N extends OrderedTreeNode<T, N>>(tree: OrderedTree<T, N>, node: N): N {
  const next = node.right!
  node.right = next.left
  next.left = update(tree, node)
  return update(tree, next)
}

function rotateRight<T, N extends OrderedTreeNode<T, N>>(tree: OrderedTree<T, N>, node: N): N {
  const next = node.left!
  node.left = next.right
  next.right = update(tree, node)
  return update(tree, next)
}

function balance<T, N extends OrderedTreeNode<T, N>>(tree: OrderedTree<T, N>, node: N): N {
  update(tree, node)
  if (height(node.left) - height(node.right) > 1) {
    if (height(node.left!.right) > height(node.left!.left)) {
      node.left = rotateLeft(tree, node.left!)
    }
    return rotateRight(tree, node)
  }
  if (height(node.right) - height(node.left) > 1) {
    if (height(node.right!.left) > height(node.right!.right)) {
      node.right = rotateRight(tree, node.right!)
    }
    return rotateLeft(tree, node)
  }
  return node
}

/** Inserts, replaces (equal order) or removes one value along a single root-to-leaf path.
 *  `visit` counts the nodes the path touches. */
export function putOrdered<T, N extends OrderedTreeNode<T, N>>(
  tree: OrderedTree<T, N>,
  node: N | undefined,
  value: T,
  remove: boolean,
  visit?: () => void
): N | undefined {
  if (!node) {
    return remove ? undefined : update(tree, tree.create(value))
  }
  visit?.()
  const order = tree.compare(value, node.value)
  if (order < 0) {
    node.left = putOrdered(tree, node.left, value, remove, visit)
  } else if (order > 0) {
    node.right = putOrdered(tree, node.right, value, remove, visit)
  } else if (!remove) {
    node.value = value
  } else {
    if (!node.left) {
      return node.right
    }
    if (!node.right) {
      return node.left
    }
    let next = node.right
    while (next.left) {
      visit?.()
      next = next.left
    }
    node.value = next.value
    node.right = putOrdered(tree, node.right, next.value, true, visit)
  }
  return balance(tree, node)
}
