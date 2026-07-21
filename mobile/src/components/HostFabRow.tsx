import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing } from '../theme/mobile-theme'
import { NewWorkspaceFab, FAB_SIZE } from './NewWorkspaceFab'
import { HostVoiceFab } from './HostVoiceFab'
import { HostVoiceTranscriptStrip } from './HostVoiceTranscriptStrip'
import { useHostVoiceAsk } from '../voice/use-host-voice-ask'
import { MobilePetOverlay } from '../pet/MobilePetOverlay'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'

// The host panel's floating overlay layer — phone only; embedded sidebars keep
// the toolbar "+" instead. Operator layout (2026-07-21): "+" bottom-LEFT,
// hold-to-talk mic bottom-RIGHT so the mic owns the thumb corner and a mis-grab
// while reaching to speak can't create a workspace. Transcript strip floats
// above both, and the pet roams the whole layer when presence says this phone
// holds it.

type HostFabRowProps = {
  client: RpcClient | null
  hostName: string
  worktrees: Worktree[]
  connected: boolean
  onNewWorkspace: () => void
}

// Owns the voice hook rather than taking it as a prop: the whole ask-Herm
// feature then lives in one subtree and the host screen just mounts it.
export function HostFabRow({
  client,
  hostName,
  worktrees,
  connected,
  onNewWorkspace
}: HostFabRowProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const voice = useHostVoiceAsk({ client, hostName, worktrees, enabled: connected })
  return (
    <>
      {/* Behind the controls: the pet must never sit over a button. */}
      <MobilePetOverlay client={client} />
      <NewWorkspaceFab onPress={onNewWorkspace} disabled={!connected} />
      <HostVoiceTranscriptStrip
        question={voice.lastQuestion}
        answer={voice.lastAnswer}
        error={voice.error}
        bottom={spacing.xl + FAB_SIZE + spacing.md + insets.bottom}
      />
      <HostVoiceFab
        phase={voice.phase}
        disabled={!connected}
        onPressIn={voice.onPressIn}
        onPressOut={voice.onPressOut}
      />
    </>
  )
}
