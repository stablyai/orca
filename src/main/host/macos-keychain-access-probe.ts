import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export type KeychainAccessProbe = {
  /** Settles within the answer window; 'prompting' means the child still waits on a Keychain dialog. */
  answer: Promise<'available' | 'unavailable' | 'prompting' | 'unknown'>
  /** Settles when the child finally exits, so a later dialog answer can be observed. */
  settled: Promise<'available' | 'unavailable' | 'unknown'>
}

export const KEYCHAIN_ACCESS_ANSWER_MS = 20_000
const KEYCHAIN_DIALOG_WAIT_MS = 30 * 60_000

// Same binary and app name as this run, so the Safe Storage item's ACL answers the child exactly as it would answer us.
const PROBE_SCRIPT = `const { app, safeStorage } = require('electron')
app.setName(process.env.ORCA_KEYCHAIN_PROBE_APP_NAME)
app.setPath('userData', process.env.ORCA_KEYCHAIN_PROBE_USER_DATA)
app.dock?.hide()
app.whenReady().then(() => {
  let available = false
  try { available = safeStorage.isEncryptionAvailable() } catch {}
  process.stdout.write(available ? 'keychain-probe:available\\n' : 'keychain-probe:unavailable\\n')
  app.exit(0)
})
`

/** Touch the Safe Storage key in a child Electron so an ACL prompt (new Electron binary) cannot freeze this main thread. */
export function probeMacosKeychainAccess(options: {
  electronPath: string
  appName: string
  answerMs?: number
  dialogWaitMs?: number
  run?: typeof runProcess
}): KeychainAccessProbe {
  const settled = runAccessProbe(options)
  const answer = new Promise<'available' | 'unavailable' | 'prompting' | 'unknown'>((resolve) => {
    const timer = setTimeout(
      () => resolve('prompting'),
      options.answerMs ?? KEYCHAIN_ACCESS_ANSWER_MS
    )
    timer.unref?.()
    void settled.then((result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
  return { answer, settled }
}

async function runAccessProbe(options: {
  electronPath: string
  appName: string
  dialogWaitMs?: number
  run?: typeof runProcess
}): Promise<'available' | 'unavailable' | 'unknown'> {
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'orca-keychain-probe-'))
    const script = join(dir, 'probe.cjs')
    await writeFile(script, PROBE_SCRIPT)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ORCA_KEYCHAIN_PROBE_APP_NAME = options.appName
    env.ORCA_KEYCHAIN_PROBE_USER_DATA = join(dir, 'user-data')
    const result = await (options.run ?? runProcess)({
      program: options.electronPath,
      args: [script, `--user-data-dir=${join(dir, 'user-data')}`],
      env,
      timeoutMs: options.dialogWaitMs ?? KEYCHAIN_DIALOG_WAIT_MS,
      maxOutputBytes: 16 * 1024
    })
    if (result.stdout.includes('keychain-probe:available')) {
      return 'available'
    }
    return result.stdout.includes('keychain-probe:unavailable') ? 'unavailable' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
