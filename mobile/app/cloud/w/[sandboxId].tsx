import { useLocalSearchParams } from 'expo-router'
import { CloudWorkspaceScreen } from '../../../src/cloud/CloudWorkspaceScreen'

/** Team share links (orca://cloud/w/<sandboxId>, from the desktop's "Copy link") open here on a phone. */
export default function CloudWorkspaceLinkRoute() {
  const params = useLocalSearchParams<{ sandboxId?: string }>()
  const sandboxId = typeof params.sandboxId === 'string' ? params.sandboxId : ''
  return <CloudWorkspaceScreen key={sandboxId} sandboxId={sandboxId} />
}
