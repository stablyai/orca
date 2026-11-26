import { Linking } from 'react-native'
import {
  ANDROID_RELEASE_TAG_PREFIX,
  findNewestInstallableRelease
} from '../app-update/github-release-update-source'

export const NEW_APP_PLAY_URL = 'https://play.google.com/store/apps/details?id=dev.orca.app'
const RELEASES_PAGE_URL = 'https://github.com/stablyai/orca/releases'
const LOOKUP_TIMEOUT_MS = 10_000

async function newAppDownloadUrl(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const release = await findNewestInstallableRelease(
      (input, init) => fetch(input, init),
      ANDROID_RELEASE_TAG_PREFIX,
      controller.signal
    )
    return release?.apkUrl ?? RELEASES_PAGE_URL
  } catch {
    return RELEASES_PAGE_URL
  } finally {
    clearTimeout(timer)
  }
}

/** Opens the newest new-app APK so the browser downloads it, or the releases page when none is found. */
export async function openNewAppDownload(): Promise<void> {
  await Linking.openURL(await newAppDownloadUrl()).catch(() => {})
}
