import type { ReactTestInstance } from 'react-test-renderer'

// Mock native host names ('Pressable', 'Text') are outside findAllByType’s ElementType.
export function findAllByHostType(root: ReactTestInstance, hostType: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === hostType)
}

export function findByHostType(root: ReactTestInstance, hostType: string): ReactTestInstance {
  return root.find((node) => node.type === hostType)
}
