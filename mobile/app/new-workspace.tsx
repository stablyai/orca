import { useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../src/navigation/route-param-reader'
import { NewWorkspaceHostPicker } from '../src/new-workspace/NewWorkspaceHostPicker'
import { NewWorkspaceOverlay } from '../src/new-workspace/NewWorkspaceOverlay'
import { readOfferedHostIds } from '../src/new-workspace/new-workspace-overlay-route'

/** Home's New Workspace, over Home: which desktop, then that desktop's Create Workspace drawer. */
export default function NewWorkspaceOverlayRoute() {
  const params = useLocalSearchParams<{ hostIds?: string | string[] }>()
  const [offered] = useState(() => readOfferedHostIds(firstParam(params.hostIds)))
  const [hostId, setHostId] = useState(offered.length === 1 ? offered[0] : null)
  return (
    <>
      {offered.length === 1 ? null : (
        <NewWorkspaceHostPicker hostIds={offered} onPick={setHostId} />
      )}
      {hostId === null ? null : <NewWorkspaceOverlay hostId={hostId} />}
    </>
  )
}
