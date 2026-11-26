import { useEffect } from 'react'
import { AppState } from 'react-native'
import { readAloudParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-read-aloud-verb'
import { speakOnDevice, stopOnDevice } from './native-read-aloud-device'

// A new speak replaces the one playing, as the page plays one reply at a time; the replaced call replies when its voice stops.
// The shell stops on its own when the app leaves the foreground, since a hidden page may never send stop.
export async function serveNativeReadAloudVerb(params: unknown): Promise<Record<string, never>> {
  const read = readAloudParamsSchema.parse(params)
  stopOnDevice()
  if (read.action === 'stop') {
    return {}
  }
  const leaving = AppState.addEventListener('change', (state) => {
    if (state === 'background') {
      stopOnDevice()
    }
  })
  try {
    await speakOnDevice(read.text)
  } finally {
    leaving.remove()
  }
  return {}
}

/** A replaced page document stops whatever its predecessor was reading. */
export function useNativeReadAloudLifetime(sessionId: string | null): void {
  useEffect(() => stopOnDevice, [sessionId])
}
