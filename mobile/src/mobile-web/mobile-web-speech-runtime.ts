import type { MicrophoneDataEvent } from '@orca/expo-two-way-audio'

export type MobileWebSpeechRuntime = {
  requestMicrophonePermission: () => Promise<{ granted: boolean }>
  waitForForeground: () => Promise<boolean>
  initialize: () => Promise<boolean>
  toggleRecording: (recording: boolean) => boolean
  tearDown: () => void | Promise<void>
  addMicrophoneListener: (listener: (event: MicrophoneDataEvent) => void) => () => void
  addInterruptionListener: (listener: (kind: string) => void) => () => void
  acquireKeepAwake: (dictationId: string) => Promise<void>
  releaseKeepAwake: (dictationId?: string) => Promise<void>
}
