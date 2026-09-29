import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSync } from 'esbuild'
import { spawnProcess } from '../../../shared/child-process/run-process'

export type RecoveryCrashOptions = {
  root: string
  profileId: string
  dataFile: string
  databasePath: string
  exportPath: string
  backupPath: string
  markerPath: string
  kind: 'json' | 'sqlite'
}

/** Build only the recovery graph into an isolated test directory, never shared out/. */
export function buildRecoveryCrashProcess(directory: string): string {
  const bundle = join(directory, 'recovery-crash-api.cjs')
  buildSync({
    stdin: {
      contents: `
        export { acquireProfileStateMaintenance } from './src/main/persistence/profile-state/profile-state-access'
        export { restoreProfileStateJsonExport } from './src/main/persistence/profile-state/legacy-json/profile-state-recovery'
        export { restoreProfileStateDatabaseBackup } from './src/main/persistence/profile-state/profile-state-database-recovery'
        export { openProfileStateDatabase } from './src/main/persistence/profile-state/profile-state-database'
        export { importProfileStateJson } from './src/main/persistence/profile-state/profile-state-documents'
        export { invalidateHttp1CompatibilityMarker, writeHttp1CompatibilityMarker } from './src/main/startup/http1-compatibility-marker'
      `,
      loader: 'ts',
      resolveDir: process.cwd()
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  return bundle
}

const CHILD_SOURCE = `
const fs = require('node:fs')
const [bundle, raw, stage, payloadPath] = process.argv.slice(2)
const options = JSON.parse(raw)
const payload = fs.readFileSync(payloadPath, 'utf8')
const api = require(bundle)
const barrier = label => {
  if (label !== stage) return
  fs.writeSync(1, label + '\\n')
  fs.readSync(0, Buffer.alloc(1), 0, 1)
  throw new Error('Crash barrier unexpectedly resumed')
}
if (stage === 'seed') {
  const source = api.openProfileStateDatabase(options.databasePath, options.profileId)
  api.importProfileStateJson(source.db, payload, { expectedRevision: 3 })
  barrier('seed')
}
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (to === options.dataFile) barrier('json-publish:before')
  if (to === options.databasePath) barrier('sqlite-publish:before')
  if (to === options.markerPath) barrier('marker-publish:before')
  rename(from, to)
  if (to === options.dataFile) barrier('json-publish:after')
  if (to === options.databasePath) barrier('sqlite-publish:after')
  if (to === options.markerPath) barrier('marker-publish:after')
}
const rm = fs.rmSync
fs.rmSync = (target, ...rest) => {
  rm(target, ...rest)
  barrier('removed:' + target)
}
let clone = 0
const link = fs.linkSync
fs.linkSync = (from, to) => {
  const isClone = from.includes('.orca-recovery-clone-')
  if (isClone) barrier('clone:' + (++clone) + ':before')
  link(from, to)
  if (isClone) barrier('clone:' + clone + ':after')
}
const fsync = fs.fsyncSync
fs.fsyncSync = descriptor => {
  fsync(descriptor)
  if (fs.fstatSync(descriptor).isDirectory() && !fs.existsSync(options.exportPath)) {
    barrier('cleanup-directory-synced')
  }
}
const maintenance = api.acquireProfileStateMaintenance(options.root)
const recovered = (options.kind === 'json'
  ? api.restoreProfileStateJsonExport
  : api.restoreProfileStateDatabaseBackup)({
    ...options, maintenance,
    beforeRestore: () => api.invalidateHttp1CompatibilityMarker(options.root)
  })
barrier('restore-returned')
api.writeHttp1CompatibilityMarker(options.root, true, options.profileId)
barrier('marker-refreshed')
maintenance.release()
throw new Error('Requested crash boundary was not reached: ' + stage)
`

/** A pipe barrier proves the syscall completed before the parent sends SIGKILL. */
export async function killRecoveryAt(
  bundle: string,
  options: RecoveryCrashOptions,
  stage: string,
  payload = ''
): Promise<void> {
  const childScript = join(dirname(bundle), 'recovery-crash-child.cjs')
  const payloadPath = join(dirname(bundle), 'recovery-crash-payload.json')
  writeFileSync(childScript, CHILD_SOURCE, 'utf8')
  writeFileSync(payloadPath, payload, 'utf8')
  const childEnv = {
    ORCA_BACKGROUND_LAUNCH: '1',
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {})
  }
  const recoveryOptions: RecoveryCrashOptions = {
    root: options.root,
    profileId: options.profileId,
    dataFile: options.dataFile,
    databasePath: options.databasePath,
    exportPath: options.exportPath,
    backupPath: options.backupPath,
    markerPath: options.markerPath,
    kind: options.kind
  }
  const child = spawnProcess({
    program: process.execPath,
    args: [childScript, bundle, JSON.stringify(recoveryOptions), stage, payloadPath],
    env: childEnv
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = ''
      const timer = setTimeout(
        () => finish(new Error(`Crash boundary timed out: ${stage}; ${stderr}`)),
        10_000
      )
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes(`${stage}\n`)) {
          finish()
        }
      }
      const onExit = () => finish(new Error(`Recovery exited before ${stage}: ${stderr}`))
      const onError = (error: Error) => finish(error)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        child.off('error', onError)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
    }
  }
}
