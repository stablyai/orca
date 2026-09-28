import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from './script-child-process.mjs'

export function prepareSmokeKeychain(home, execute = runProcessSync) {
  if (process.platform !== 'darwin' || process.env.CI !== 'true') {
    return undefined
  }
  const keychain = join(home, 'Library', 'Keychains', 'login.keychain-db')
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true })
  const run = (args) =>
    execute({
      program: '/usr/bin/security',
      args,
      env: { ...process.env, HOME: home },
      timeoutMs: 10_000
    })
  const previous = run(['default-keychain', '-d', 'user'])
  const previousPath = previous.code === 0 ? JSON.parse(previous.stdout.trim()) : null
  const cleanup = () => {
    try {
      if (previousPath) {
        checked(['default-keychain', '-d', 'user', '-s', previousPath])
      }
    } finally {
      checked(['delete-keychain', keychain])
    }
  }
  const checked = (args) => {
    const result = run(args)
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`Disposable CI keychain operation failed: ${args[0]}`)
    }
  }
  const password = randomUUID()
  checked(['create-keychain', '-p', password, keychain])
  try {
    checked(['set-keychain-settings', '-lut', '3600', keychain])
    checked(['unlock-keychain', '-p', password, keychain])
    // The isolated HOME otherwise sends Electron's encryption request to login UI.
    checked(['default-keychain', '-d', 'user', '-s', keychain])
  } catch (error) {
    cleanup()
    throw error
  }
  return cleanup
}
