#!/usr/bin/env node
// Fails when an Orca sync brings stablyai/orca back into the updater (docs/zotz/UPDATES-SPEC.md §5.1).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/main/updater', 'src/shared/release-channel.ts', 'config/dev-app-update.yml']
// Matches the plain URL form and the escaped form used inside regex literals.
const UPSTREAM_MAIN_REPO = /stablyai(?:\/|\\\/)orca(?![-\w])/

function* sourceFiles(path) {
  if (statSync(path).isFile()) {
    yield path
    return
  }
  for (const name of readdirSync(path)) {
    yield* sourceFiles(join(path, name))
  }
}

const offenders = []
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    if (/\.test\.|[/\\]testing[/\\]/.test(file)) {
      continue
    }
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (UPSTREAM_MAIN_REPO.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      })
  }
}
if (offenders.length > 0) {
  console.error('The updater must read Zotz releases (ZOTZ_RELEASE_REPO), not stablyai/orca:')
  console.error(offenders.join('\n'))
  process.exit(1)
}
console.log('Updater release references point at Zotz.')
