import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'

export default function MobileFileExplorerScreen() {
  const { hostId, worktreeId, name } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  return (
    <MobileFileExplorerPanel hostId={hostId} worktreeId={worktreeId} name={name} embedded={false} />
  )
}
