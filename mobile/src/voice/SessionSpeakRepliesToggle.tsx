import React from 'react'
import { Loader, Volume2, VolumeX } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from '../session/MobileSessionHeaderIconButton'
import { useSpeakRepliesToggle } from './speak-back-context'

// "Speak replies" for a terminal agent session. Off by default, remembered per
// workspace. The watcher itself lives in SpeakBackProvider above the navigator,
// so arming a workspace keeps speaking after you navigate away from it — this
// control only arms and disarms.

export function SessionSpeakRepliesToggle({
  hostId,
  worktreeId
}: {
  hostId: string
  worktreeId: string
}): React.JSX.Element {
  const { enabled, busy, toggle } = useSpeakRepliesToggle(hostId, worktreeId)

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
