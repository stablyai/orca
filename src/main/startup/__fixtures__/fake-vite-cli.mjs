import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const markerFile = process.env.ORCA_DEV_WRAPPER_TEST_VITE_FILE

if (markerFile) {
  mkdirSync(path.dirname(markerFile), { recursive: true })
  writeFileSync(markerFile, `${process.argv.slice(2).join('\n')}\n`, 'utf8')
}
