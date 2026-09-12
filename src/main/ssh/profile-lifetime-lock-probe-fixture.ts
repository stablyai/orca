import { openSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  acquireProfileLifetimeLock,
  type ProfileLifetimeLockBinding
} from './profile-lifetime-lock'

const [profile, mode, addon] = process.argv.slice(2)
const binding: ProfileLifetimeLockBinding = createRequire(resolve(process.argv[1]))(addon)
let lock: ReturnType<typeof acquireProfileLifetimeLock>
try {
  lock = acquireProfileLifetimeLock(profile, binding)
} catch (error) {
  if ((error as { code?: string }).code === 'profile_lock_busy') {
    console.log(JSON.stringify({ state: 'busy' }))
    process.exit(0)
  }
  throw error
}
console.log(JSON.stringify({ state: 'acquired' }))
if (mode === 'probe') {
  lock.release(() => {})
} else {
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    if (line === 'release') {
      lock.release(() => {})
      input.close()
      process.stdin.destroy()
    } else if (line === 'external-read') {
      closeSync(openSync(join(profile, 'profile-lifetime.lock'), 'r'))
      lock.assertCurrent()
      console.log(JSON.stringify({ state: 'external-read' }))
    } else if (line === 'assert') {
      try {
        lock.assertCurrent()
        console.log(JSON.stringify({ state: 'current' }))
      } catch {
        console.log(JSON.stringify({ state: 'invalid' }))
      }
    }
  })
}
