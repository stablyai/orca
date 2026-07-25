import AsyncStorage from '@react-native-async-storage/async-storage'

// "Speak replies" is remembered PER WORKSPACE (operator decision 2026-07-21):
// arming it globally would make every background workspace talk at you, and
// arming it per-app-run would mean re-arming it every time you reopen a session
// you are actively working in by voice.
//
// Default OFF everywhere. A device that starts talking on its own without being
// asked is a worse failure than one that stays quiet.

const SPEAK_REPLIES_PREFIX = 'orca:speakReplies:'

function speakRepliesKey(hostId: string, worktreeId: string): string {
  return `${SPEAK_REPLIES_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

export async function loadSpeakReplies(hostId: string, worktreeId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(speakRepliesKey(hostId, worktreeId))) === '1'
  } catch {
    // Why default off on a read failure: unreadable storage must not be the
    // reason a phone unexpectedly starts speaking.
    return false
  }
}

export async function saveSpeakReplies(
  hostId: string,
  worktreeId: string,
  enabled: boolean
): Promise<void> {
  try {
    await AsyncStorage.setItem(speakRepliesKey(hostId, worktreeId), enabled ? '1' : '0')
  } catch {
    // Why swallow: the toggle already applies to the live session from React
    // state. Losing only the persistence is not worth interrupting the user.
  }
}
