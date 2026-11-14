import { verifyPlaywrightParticipation } from './verify-playwright-participation.mjs'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// A skipped E9 guard would pass silently; the lane must prove it actually ran.
export const WSL_NO_BACKGROUND_BOOT_TITLES = [
  'starts nothing in the stopped distro until the user opens a terminal there',
  'a focused WSL workspace left idle through the stop never starts it again'
]

export function verifyWslNoBackgroundBootParticipation(report) {
  verifyPlaywrightParticipation(report, {
    titles: WSL_NO_BACKGROUND_BOOT_TITLES,
    label: 'WSL E9 guard'
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWslNoBackgroundBootParticipation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('Both WSL E9 guards passed three times without skips or retries.')
}
