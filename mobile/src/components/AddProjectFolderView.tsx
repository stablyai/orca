import type { ReactNode } from 'react'
import { View } from 'react-native'
import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'
import type { RpcClient } from '../transport/rpc-client'

export function AddProjectFolderView({
  targetSelector,
  destination,
  client,
  sshConnectionId,
  busy,
  error,
  onBack,
  onPick
}: {
  targetSelector?: ReactNode
  destination: boolean
  client: RpcClient | null
  sshConnectionId: string | null
  busy: boolean
  error: string
  onBack: () => void
  onPick: (path: string) => void
}) {
  return (
    <View>
      {targetSelector}
      <AddProjectFolderBrowser
        client={client}
        sshConnectionId={sshConnectionId}
        busy={busy}
        error={error}
        pickLabel={destination ? 'Select folder' : undefined}
        onBack={onBack}
        onPick={onPick}
      />
    </View>
  )
}
