import { writeFileSync } from 'node:fs'

const markerPath = process.env.ORCA_DEV_WRAPPER_TEST_ENV_FILE
if (!markerPath) {
  throw new Error('ORCA_DEV_WRAPPER_TEST_ENV_FILE is required')
}
writeFileSync(markerPath, JSON.stringify({ args: process.argv.slice(2) }), 'utf8')
