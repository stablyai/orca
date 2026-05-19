import { type PermissionResponse } from 'expo-modules-core'
import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'

export async function initialize() {
  return await ExpoTwoWayAudioModule.initialize()
}

export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData)
}

export function bypassVoiceProcessing(bypass: boolean) {
  return ExpoTwoWayAudioModule.bypassVoiceProcessing(bypass)
}

export function toggleRecording(val: boolean): boolean {
  return ExpoTwoWayAudioModule.toggleRecording(val)
}

export function isRecording(): boolean {
  return ExpoTwoWayAudioModule.isRecording()
}

export function tearDown() {
  return ExpoTwoWayAudioModule.tearDown()
}

export function restart() {
  return ExpoTwoWayAudioModule.restart()
}

export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.getMicrophonePermissionsAsync()
}

export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.requestMicrophonePermissionsAsync()
}

export function getMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.getMicrophoneModeIOS()
}

export function setMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.setMicrophoneModeIOS()
}

export function isPlaying(): boolean {
  return ExpoTwoWayAudioModule.isPlaying()
}

export function stopPlayback() {
  return ExpoTwoWayAudioModule.stopPlayback()
}

export function pausePlayback() {
  return ExpoTwoWayAudioModule.pausePlayback()
}

export function resumePlayback() {
  return ExpoTwoWayAudioModule.resumePlayback()
}
