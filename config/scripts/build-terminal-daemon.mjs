import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOrcadChildEntry, ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

const root = resolve(import.meta.dirname, '../..')

export async function buildTerminalDaemon(outputDir = join(root, 'out', 'terminal-daemon')) {
  mkdirSync(outputDir, { recursive: true })
  return Promise.all([
    buildOrcadChildEntry(ORCAD_CHILD_ENTRY_POINTS.daemon, join(outputDir, 'daemon-entry.js')),
    buildOrcadChildEntry(
      ORCAD_CHILD_ENTRY_POINTS.ptyGate,
      join(outputDir, 'windows-bun-pty-gate-entry.js')
    )
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildTerminalDaemon()
}
