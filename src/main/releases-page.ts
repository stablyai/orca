import { dialog, shell } from 'electron'
import { PHORCA_RELEASES_URL } from '../shared/release-channel'

const RELEASES_OPEN_FAILURE_TITLE = 'Unable to open Phorca Releases'

export async function openReleasesPage(): Promise<void> {
  try {
    await shell.openExternal(PHORCA_RELEASES_URL)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[releases] Failed to open ${PHORCA_RELEASES_URL}: ${detail}`)
    dialog.showErrorBox(
      RELEASES_OPEN_FAILURE_TITLE,
      `The Phorca Releases page could not be opened. Try opening ${PHORCA_RELEASES_URL} in your browser.`
    )
  }
}
