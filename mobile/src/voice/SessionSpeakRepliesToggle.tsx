import React from 'react'
import { Loader, Volume2, VolumeX } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from '../session/MobileSessionHeaderIconButton'
import { loadSpeakReplies, saveSpeakReplies } from '../storage/speak-replies-preference'
import { useSessionSpeakBack } from './use-session-speak-back'
import type { RpcClient } from '../transport/rpc-client'

// "Speak replies" for a terminal agent session. Off by default, remembered per
// workspace. Owns the speak-back watcher so mounting this control is the whole
// feature — the session screen only has to place it.

export function SessionSpeakRepliesToggle({
  client,
  hostId,
  worktreeId
}: {
  client: RpcClient | null
  hostId: string
  worktreeId: string
}): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(false)
  const { busy } = useSessionSpeakBack({ client, worktreeId, enabled })

  // Why load in an effect keyed on the ids: switching workspaces must pick up
  // that workspace's own setting rather than carrying the previous one over.
  React.useEffect(() => {
    let cancelled = false
    void loadSpeakReplies(hostId, worktreeId).then((stored) => {
      if (!cancelled) {
        setEnabled(stored)
      }
    })
    return () => {
      cancelled = true
    }
  }, [hostId, worktreeId])

  const toggle = React.useCallback(() => {
    setEnabled((current) => {
      const next = !current
      void saveSpeakReplies(hostId, worktreeId, next)
      return next
    })
  }, [hostId, worktreeId])

  // Why surface `busy`: folding a long reply down to speakable length takes a
  // real beat (measured ~10-18s), and an unchanged icon during that gap is
  // indistinguishable from the feature having silently failed.
  const icon = busy ? Loader : enabled ? Volume2 : VolumeX
  const label = busy
    ? 'Preparing spoken reply'
    : enabled
      ? 'Turn off speak replies'
      : 'Turn on speak replies'
  return (
    <MobileSessionHeaderIconButton
      active={enabled}
      accessibilityLabel={label}
      icon={icon}
      onPress={toggle}
    />
  )
}
