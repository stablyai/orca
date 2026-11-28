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
/** Fallback kill for a confirmation child. The grace below aborts it first. */
const KEYCHAIN_CONFIRM_WAIT_MS = 60_000
/**
 * After a child that never touches Safe Storage is ready, a persistent grant has already
 * returned. A dialog still open cannot be clicked once this elapses: the child is aborted.
 * Electron's safeStorage API cannot ask the keychain to fail instead of prompting.
 */
const KEYCHAIN_PERSISTENT_GRANT_GRACE_MS = 1_000

// Same binary and app name as this run, so the Safe Storage item's ACL answers the child exactly as it would answer us.
const PROBE_SCRIPT = `const { app, safeStorage } = require('electron')
app.setName(process.env.ORCA_KEYCHAIN_PROBE_APP_NAME)
app.setPath('userData', process.env.ORCA_KEYCHAIN_PROBE_USER_DATA)
app.dock?.hide()
app.whenReady().then(() => {
  const touch = process.env.ORCA_KEYCHAIN_PROBE_TOUCH !== '0'
  let marker = touch ? 'keychain-probe:unavailable' : 'keychain-probe:ready'
  if (touch) {
    try {
      if (safeStorage.isEncryptionAvailable()) marker = 'keychain-probe:available'
    } catch {}
  }
  process.stdout.write(marker + '\\n')
  app.exit(0)
})
`

/** Touch the Safe Storage key in a child Electron so an ACL prompt (new Electron binary) cannot freeze this main thread. */
export function probeMacosKeychainAccess(options: {
  electronPath: string
  appName: string
  answerMs?: number
  dialogWaitMs?: number
  /** False proves only that Electron started. The child must not touch Safe Storage. */
  touchSafeStorage?: boolean
  signal?: AbortSignal
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

type KeychainProbeRun = {
  electronPath: string
  appName: string
  answerMs?: number
  dialogWaitMs?: number
  touchSafeStorage?: boolean
  signal?: AbortSignal
  run?: typeof runProcess
}

/**
 * True when Safe Storage answers without waiting on a person.
 * The grant child has to finish within a second of a twin that never touches the keychain;
 * otherwise it is aborted, so a later Allow once click cannot authorize it.
 */
export async function confirmMacosKeychainPersistentGrant(options: {
  electronPath: string
  appName: string
  run?: typeof runProcess
}): Promise<boolean> {
  const abort = new AbortController()
  const grant = probeMacosKeychainAccess({
    electronPath: options.electronPath,
    appName: options.appName,
    answerMs: KEYCHAIN_CONFIRM_WAIT_MS,
    dialogWaitMs: KEYCHAIN_CONFIRM_WAIT_MS,
    signal: abort.signal,
    run: options.run
  })
  const startup = probeMacosKeychainAccess({
    electronPath: options.electronPath,
    appName: options.appName,
    touchSafeStorage: false,
    answerMs: KEYCHAIN_CONFIRM_WAIT_MS,
    dialogWaitMs: KEYCHAIN_CONFIRM_WAIT_MS,
    run: options.run
  })
  let persistent = false
  try {
    persistent = await persistentGrantWithinGrace(grant.settled, startup.settled)
  } finally {
    if (!persistent) {
      abort.abort()
    }
  }
  return persistent
}

async function persistentGrantWithinGrace(
  grant: Promise<'available' | 'unavailable' | 'unknown'>,
  startup: Promise<'available' | 'unavailable' | 'unknown'>
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean) => {
      if (done) {
        return
      }
      done = true
      if (grace) {
        clearTimeout(grace)
      }
      resolve(value)
    }
    void grant.then((result) => finish(result === 'available'))
    void startup.then((result) => {
      if (result !== 'available') {
        finish(false)
        return
      }
      grace = setTimeout(() => finish(false), KEYCHAIN_PERSISTENT_GRANT_GRACE_MS)
      grace.unref?.()
    })
  })
}

async function runAccessProbe(
  options: KeychainProbeRun
): Promise<'available' | 'unavailable' | 'unknown'> {
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'orca-keychain-probe-'))
    const script = join(dir, 'probe.cjs')
    await writeFile(script, PROBE_SCRIPT)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ORCA_KEYCHAIN_PROBE_APP_NAME = options.appName
    env.ORCA_KEYCHAIN_PROBE_USER_DATA = join(dir, 'user-data')
    env.ORCA_KEYCHAIN_PROBE_TOUCH = options.touchSafeStorage === false ? '0' : '1'
    const result = await (options.run ?? runProcess)({
      program: options.electronPath,
      args: [script, `--user-data-dir=${join(dir, 'user-data')}`],
      env,
      timeoutMs: options.dialogWaitMs ?? KEYCHAIN_DIALOG_WAIT_MS,
      maxOutputBytes: 16 * 1024,
      signal: options.signal
    })
    if (result.stdout.includes('keychain-probe:available')) {
      return 'available'
    }
    if (options.touchSafeStorage === false && result.stdout.includes('keychain-probe:ready')) {
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
