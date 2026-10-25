import type { ReactTestInstance } from 'react-test-renderer'

// Mocked react-native modules render host components as bare names ('Pressable', 'Text'), which
// findAllByType's ElementType parameter cannot express.
export function findAllByHostType(root: ReactTestInstance, hostType: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === hostType)
}

export function findByHostType(root: ReactTestInstance, hostType: string): ReactTestInstance {
  return root.find((node) => node.type === hostType)
}
