/** The reader's steps, in the app log (`adb logcat`), for when a phone stays silent. */
export function logSpeechEvent(event: string): void {
  console.info(`[read-aloud] ${event}`)
}
