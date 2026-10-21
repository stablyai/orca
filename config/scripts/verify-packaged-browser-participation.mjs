import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { verifyPlaywrightParticipation } from './verify-playwright-participation.mjs'

export const PACKAGED_BROWSER_TEST_TITLES = [
  'keeps an old packaged client on the current server-hosted path',
  'keeps a current client on an old packaged server-hosted path'
]

export function verifyPackagedBrowserParticipation(report) {
  verifyPlaywrightParticipation(report, {
    titles: PACKAGED_BROWSER_TEST_TITLES,
    label: 'Packaged browser'
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPackagedBrowserParticipation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('Both packaged browser directions passed three times without skips or retries.')
}
