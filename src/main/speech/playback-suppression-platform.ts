import { join, win32 } from 'node:path'
import type { PlaybackSuppressionAdapter } from './playback-suppression-service'
import { createLinuxPlaybackSuppressionAdapter } from './playback-suppression-linux'
import {
  createNativePlaybackSuppressionAdapter,
  type NativePlaybackSuppressionRunner
} from './playback-suppression-native'

type SupportedPlatform = NodeJS.Platform

type PlatformAdapterOptions = {
  isPackaged: boolean
  resourcesPath: string
  projectRoot?: string
  runNative?: NativePlaybackSuppressionRunner
}

const unsupportedAdapter: PlaybackSuppressionAdapter = {
  getCapability: async () => false,
  snapshot: async () => {
    throw new Error('System audio muting is not supported on this operating system.')
  },
  setMuted: async () => {
    throw new Error('System audio muting is not supported on this operating system.')
  }
}

export function createPlaybackSuppressionAdapter(
  platform: SupportedPlatform,
  options: PlatformAdapterOptions
): PlaybackSuppressionAdapter {
  if (platform === 'linux') {
    return createLinuxPlaybackSuppressionAdapter()
  }
  const executableName =
    platform === 'win32'
      ? 'orca-playback-suppression.exe'
      : platform === 'darwin'
        ? 'orca-playback-suppression'
        : null
  if (!executableName) {
    return unsupportedAdapter
  }
  const joinPath = platform === 'win32' ? win32.join : join
  const executablePath = options.isPackaged
    ? joinPath(options.resourcesPath, 'playback-suppression', executableName)
    : joinPath(
        options.projectRoot ?? process.cwd(),
        'native',
        platform === 'darwin' ? 'playback-suppression-macos' : 'playback-suppression-windows',
        '.build',
        platform === 'darwin' ? 'release' : '',
        executableName
      )
  return createNativePlaybackSuppressionAdapter({
    backend: platform === 'darwin' ? 'coreaudio' : 'windows-core-audio',
    executablePath,
    run: options.runNative
  })
}
