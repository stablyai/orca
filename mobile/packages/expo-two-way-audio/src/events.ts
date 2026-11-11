import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'
import type { SpeechDownloadProgressEvent, SpeechErrorEvent, SpeechTextEvent } from './speech'

export interface MicrophoneDataEvent {
  data: Uint8Array
}

export interface VolumeLevelEvent {
  data: number
}

export interface RecordingChangeEvent {
  data: boolean
}

export interface AudioInterruptionEvent {
  data: string
}

export interface ExpoTwoWayAudioEventMap {
  onMicrophoneData: MicrophoneDataEvent
  onInputVolumeLevelData: VolumeLevelEvent
  onRecordingChange: RecordingChangeEvent
  onAudioInterruption: AudioInterruptionEvent
  onSpeechText: SpeechTextEvent
  onSpeechError: SpeechErrorEvent
  onSpeechDownloadProgress: SpeechDownloadProgressEvent
}

export type MicrophoneDataCallback = (event: MicrophoneDataEvent) => void
export type VolumeLevelCallback = (event: VolumeLevelEvent) => void
export type RecordingChangeCallback = (event: RecordingChangeEvent) => void
export type AudioInterruptionCallback = (event: AudioInterruptionEvent) => void

export function addExpoTwoWayAudioEventListener<K extends keyof ExpoTwoWayAudioEventMap>(
  eventName: K,
  handler: (ev: ExpoTwoWayAudioEventMap[K]) => void
) {
  return ExpoTwoWayAudioModule.addListener(eventName, handler)
}
