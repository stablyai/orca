import { verifyPlaywrightParticipation } from './verify-playwright-participation.mjs'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WSL_TEST_TITLES = [
  'tab-bar + menu launches an agent inside WSL @tab-bar-agent-launch-golden',
  'WSL terminal keyboard paste preserves Linux shell content with one PTY owner',
  'existing WSL terminal keeps paste runtime after default shell changes'
]

export function verifyWslParticipation(report) {
  verifyPlaywrightParticipation(report, { titles: WSL_TEST_TITLES, label: 'WSL' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWslParticipation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('All three WSL scenarios passed three times without skips or retries.')
}
