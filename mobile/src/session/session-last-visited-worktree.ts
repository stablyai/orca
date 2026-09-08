import AsyncStorage from '@react-native-async-storage/async-storage'

export function persistSessionLastVisitedWorktree(
  hostId: string,
  worktreeId: string
): Promise<void> {
  return AsyncStorage.setItem('orca:last-visited-worktree', JSON.stringify({ hostId, worktreeId }))
}
