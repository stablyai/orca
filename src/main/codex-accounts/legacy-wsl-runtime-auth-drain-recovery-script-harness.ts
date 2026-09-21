// Why: runs the drain's recovery and absent-legacy-home guest scripts under `sh`.
import { execFileSync } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RETIRED_SESSION,
  RETIRED_SESSION_SEGMENTS,
  SOURCE_AUTH,
  TARGET_AUTH
} from './legacy-wsl-runtime-auth-drain-script-fixtures'

export function runRecoveryScript(options: {
  destinationRecovery?: boolean
  markerPresent: boolean
  pathMetadata?: boolean
  script: string
}): {
  destinationMode: number
  destinationRecoveryExists: boolean
  destinationRecoveryPathExists: boolean
  markerExists: boolean
  sourceAuth: string | null
  sourceRecoveryExists: boolean
  status: number
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-recovery-'))
  const legacyHome = join(root, 'legacy')
  const targetHome = join(root, 'account')
  mkdirSync(legacyHome)
  mkdirSync(targetHome)
  const markerPath = join(root, 'drain-marker.json')
  const sourceRecoveryPath = `${markerPath}.orca-drain-source`
  const destinationRecoveryPath = `${markerPath}.orca-drain-destination`
  const destinationRecoveryTargetPath = `${markerPath}.orca-drain-destination-path`
  const sourceAuthPath = join(legacyHome, 'auth.json')
  const destinationAuthPath = join(targetHome, 'auth.json')
  writeFileSync(sourceRecoveryPath, SOURCE_AUTH, { mode: 0o400 })
  writeFileSync(destinationAuthPath, TARGET_AUTH, { mode: 0o400 })
  if (options.destinationRecovery !== false) {
    linkSync(destinationAuthPath, destinationRecoveryPath)
  }
  if (options.pathMetadata !== false) {
    writeFileSync(destinationRecoveryTargetPath, `${destinationAuthPath}\0`, { mode: 0o600 })
  }
  if (options.markerPresent) {
    writeFileSync(markerPath, '{"completed":true}\n')
  }
  let status = 0
  try {
    execFileSync(
      '/bin/sh',
      ['-c', options.script, 'sh', legacyHome, join(root, 'absent-active-home'), markerPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true }
    )
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  return {
    destinationMode: statSync(destinationAuthPath).mode & 0o777,
    destinationRecoveryExists: existsSync(destinationRecoveryPath),
    destinationRecoveryPathExists: existsSync(destinationRecoveryTargetPath),
    markerExists: existsSync(markerPath),
    sourceAuth: existsSync(sourceAuthPath) ? readFileSync(sourceAuthPath, 'utf8') : null,
    sourceRecoveryExists: existsSync(sourceRecoveryPath),
    status
  }
}

export function runAbsentLegacyHomeScript(options: {
  activeHomeOnly?: boolean
  createLegacyHome: boolean
  markerParentMissing?: boolean
  script: string
}): {
  markerExists: boolean
  status: number
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-absent-home-'))
  const legacyHome = join(root, 'legacy')
  const activeHome = join(root, 'absent-active-home')
  const markerPath = options.markerParentMissing
    ? join(root, 'marker-parent', 'drain-marker.json')
    : join(root, 'drain-marker.json')
  if (options.createLegacyHome) {
    const sessionHome = options.activeHomeOnly ? activeHome : legacyHome
    mkdirSync(join(sessionHome, ...RETIRED_SESSION_SEGMENTS.slice(0, -1)), { recursive: true })
    writeFileSync(join(sessionHome, ...RETIRED_SESSION_SEGMENTS), RETIRED_SESSION)
  }
  let status = 0
  try {
    execFileSync('/bin/sh', ['-c', options.script, 'sh', legacyHome, activeHome, markerPath], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000
    })
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  return { markerExists: existsSync(markerPath), status }
}
