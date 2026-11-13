#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const target = join(root, 'build-profile.json5')
if (existsSync(target)) {
  console.log('Kept existing local build-profile.json5 (including local signing).')
} else {
  copyFileSync(join(root, 'build-profile.example.json5'), target)
  console.log(
    'Created unsigned local build-profile.json5. Configure device signing in DevEco Studio.'
  )
}
