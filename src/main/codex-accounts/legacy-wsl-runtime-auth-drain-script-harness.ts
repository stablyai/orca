// Why: runs the real guest apply script under `sh` with shimmed coreutils so tests can inject
// precise interference at chosen points.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDrainInterferenceShims } from './legacy-wsl-runtime-auth-drain-script-interference-shims'
import {
  INTRUDER_AUTH,
  NEWER_AUTH,
  RETIRED_SESSION_SEGMENTS,
  SOURCE_AUTH,
  TARGET_AUTH,
  TORN_AUTH,
  sha256
} from './legacy-wsl-runtime-auth-drain-script-fixtures'
import type {
  DrainApplyInterference,
  DrainApplyOutcome
} from './legacy-wsl-runtime-auth-drain-script-run-types'
import { _internals } from './legacy-wsl-runtime-auth-drain'

export function runApplyScript(options: DrainApplyInterference = {}): DrainApplyOutcome {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-apply-'))
  const legacyHome = join(root, 'legacy')
  const targetHome = join(root, 'account')
  const binDir = join(root, 'bin')
  for (const dir of [legacyHome, targetHome, binDir]) {
    mkdirSync(dir, { recursive: true })
  }
  const legacyAuthPath = join(legacyHome, 'auth.json')
  const targetAuthPath = join(targetHome, 'auth.json')
  const legacyCredentialsPath = join(legacyHome, '.credentials.json')
  const targetCredentialsPath = join(targetHome, '.credentials.json')
  const markerPath = join(root, 'drain-marker.json')
  writeFileSync(legacyAuthPath, SOURCE_AUTH)
  writeFileSync(targetAuthPath, TARGET_AUTH)
  if (options.sourceAuthSymlink) {
    const sourceAuthTarget = join(root, 'linked-source-auth.json')
    renameSync(legacyAuthPath, sourceAuthTarget)
    symlinkSync(sourceAuthTarget, legacyAuthPath)
  }
  if (options.sourceCredentials !== undefined) {
    writeFileSync(legacyCredentialsPath, options.sourceCredentials)
  }
  if (options.sourceSession !== undefined) {
    const sessionPath = join(legacyHome, ...RETIRED_SESSION_SEGMENTS)
    mkdirSync(join(sessionPath, '..'), { recursive: true })
    writeFileSync(sessionPath, options.sourceSession)
  }

  const counterPath = join(root, 'hash-calls')
  writeFileSync(counterPath, '0')
  installDrainInterferenceShims(binDir, options)
  if (options.killDuringSessionCommit) {
    const rmShimPath = join(binDir, 'rm')
    writeFileSync(
      rmShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const result = spawnSync('/bin/rm', args, { stdio: 'inherit' })
const target = args.at(-1) ?? ''
if (
  result.status === 0 &&
  fs.existsSync(process.env.SESSION_COMMIT_MARKER) &&
  target.includes('/account/sessions/') &&
  target.includes('.orca-bridge-')
) {
  const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.ppid)], {
    encoding: 'utf8'
  })
  process.kill(Number(parent.stdout.trim()), 'SIGKILL')
}
process.exit(result.status ?? 1)
`
    )
    chmodSync(rmShimPath, 0o755)
  }
  if (
    options.crossFilesystemBridge ||
    options.killBeforeDestinationRecoveryLink ||
    options.killAfterSessionLink ||
    options.replaceTargetAfterSessionLink ||
    options.rewriteQuarantineAfterSessionLink ||
    options.rewriteSourceAfterSessionLink ||
    options.rewriteTargetAfterSessionLink
  ) {
    const lnShimPath = join(binDir, 'ln')
    writeFileSync(
      lnShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (
  process.env.KILL_DESTINATION_RECOVERY === '1' &&
  args.at(-1)?.endsWith('.orca-drain-destination')
) {
  process.kill(process.ppid, 'SIGKILL')
  process.exit(1)
}
if (
  process.env.CROSS_FILESYSTEM_BRIDGE === '1' &&
  args.at(-2)?.includes('.orca-drain-session-stage') &&
  args.at(-1)?.includes('.orca-bridge-')
) {
  process.exit(1)
}
const result = spawnSync('/bin/ln', args, { stdio: 'inherit' })
if (
  result.status === 0 &&
  args.at(-1)?.includes('/account/sessions/') &&
  args.at(-1)?.endsWith('/retired.jsonl')
) {
  if (process.env.KILL_SESSION_LINK === '1') {
    const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.ppid)], {
      encoding: 'utf8'
    })
    process.kill(Number(parent.stdout.trim()), 'SIGKILL')
  } else if (process.env.REWRITE_AFTER_SESSION_LINK === '1') {
    if (process.env.REPLACE_TARGET === '1') {
      const replacement = process.env.REWRITE_SESSION_AUTH + '.replacement'
      fs.writeFileSync(replacement, process.env.REWRITE_BYTES)
      fs.renameSync(replacement, process.env.REWRITE_SESSION_AUTH)
    } else {
      if (process.env.REWRITE_QUARANTINE === '1') {
        fs.chmodSync(process.env.REWRITE_SESSION_AUTH, 0o600)
      }
      fs.writeFileSync(process.env.REWRITE_SESSION_AUTH, process.env.REWRITE_BYTES)
    }
  }
}
process.exit(result.status ?? 1)
`
    )
    chmodSync(lnShimPath, 0o755)
  }

  let status = 0
  try {
    execFileSync(
      '/bin/sh',
      [
        '-c',
        _internals.applyLegacyAuthScript,
        'sh',
        legacyHome,
        join(root, 'absent-active-home'),
        markerPath,
        targetHome,
        sha256(SOURCE_AUTH),
        sha256(TARGET_AUTH),
        options.promoteAuth === false ? '0' : '1',
        options.deleteSource ? '1' : '0',
        options.sourceCredentials === undefined ? 'missing' : sha256(options.sourceCredentials),
        'full'
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          HASH_COUNTER: counterPath,
          REPLACE_ON_HASH_OF: options.replaceTargetOnHashOf ?? '',
          REPLACE_PATH: targetAuthPath,
          REPLACE_BYTES: INTRUDER_AUTH,
          CROSS_FILESYSTEM_BRIDGE: options.crossFilesystemBridge ? '1' : '0',
          KILL_DESTINATION: options.killAfterDestinationInstall ? '1' : '0',
          KILL_DESTINATION_RECOVERY: options.killBeforeDestinationRecoveryLink ? '1' : '0',
          KILL_SESSION_LINK: options.killAfterSessionLink ? '1' : '0',
          KILL_SOURCE: options.killAfterSourceRemoval ? '1' : '0',
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SESSION_COMMIT_MARKER: `${markerPath}.orca-drain-session-commit`,
          REWRITE_AFTER: options.rewriteAfterHashCall ? String(options.rewriteAfterHashCall) : '',
          REWRITE_AFTER_SESSION_LINK:
            options.replaceTargetAfterSessionLink ||
            options.rewriteQuarantineAfterSessionLink ||
            options.rewriteSourceAfterSessionLink ||
            options.rewriteTargetAfterSessionLink
              ? '1'
              : '0',
          REWRITE_BYTES: options.rewriteBytes ?? TORN_AUTH,
          REWRITE_QUARANTINE: options.rewriteQuarantineAfterSessionLink ? '1' : '0',
          REPLACE_TARGET: options.replaceTargetAfterSessionLink ? '1' : '0',
          REWRITE_SESSION_AUTH:
            options.rewriteTargetAfterSessionLink || options.replaceTargetAfterSessionLink
              ? targetAuthPath
              : options.rewriteQuarantineAfterSessionLink
                ? `${markerPath}.orca-drain-live-source`
                : legacyAuthPath,
          REWRITE_TARGET:
            options.rewriteTarget === 'source-credentials'
              ? legacyCredentialsPath
              : options.rewriteTarget === 'target-auth'
                ? targetAuthPath
                : legacyAuthPath
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000
      }
    )
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  if (
    options.killAfterDestinationInstall ||
    options.killBeforeDestinationRecoveryLink ||
    options.killAfterSessionLink ||
    options.killAfterSourceRemoval ||
    options.killDuringSessionCommit
  ) {
    if (options.rewriteQuarantineBeforeRecovery) {
      const quarantinePath = `${markerPath}.orca-drain-live-source`
      chmodSync(quarantinePath, 0o600)
      writeFileSync(quarantinePath, NEWER_AUTH)
    }
    if (options.replaceTargetBeforeRecovery) {
      const replacementPath = `${targetAuthPath}.replacement`
      writeFileSync(replacementPath, NEWER_AUTH)
      renameSync(replacementPath, targetAuthPath)
    }
    try {
      execFileSync(
        '/bin/sh',
        [
          '-c',
          _internals.inspectLegacyAuthScript,
          'sh',
          legacyHome,
          join(root, 'absent-active-home'),
          markerPath
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true }
      )
    } catch {
      // Recovery succeeds before inspect continues and emits the pending auth payload.
    }
  }
  return {
    legacyAuth: existsSync(legacyAuthPath) ? readFileSync(legacyAuthPath, 'utf8') : null,
    markerExists: existsSync(markerPath),
    status,
    targetAuth: readFileSync(targetAuthPath, 'utf8'),
    targetCredentials: existsSync(targetCredentialsPath)
      ? readFileSync(targetCredentialsPath, 'utf8')
      : null,
    targetMode: statSync(targetAuthPath).mode & 0o777,
    targetSession: existsSync(join(targetHome, ...RETIRED_SESSION_SEGMENTS))
      ? readFileSync(join(targetHome, ...RETIRED_SESSION_SEGMENTS), 'utf8')
      : null,
    sourceQuarantineAuth: existsSync(`${markerPath}.orca-drain-live-source`)
      ? readFileSync(`${markerPath}.orca-drain-live-source`, 'utf8')
      : null,
    sourceRecoveryAuth: existsSync(`${markerPath}.orca-drain-source`)
      ? readFileSync(`${markerPath}.orca-drain-source`, 'utf8')
      : null,
    destinationRecoveryAuth: existsSync(`${markerPath}.orca-drain-destination`)
      ? readFileSync(`${markerPath}.orca-drain-destination`, 'utf8')
      : null,
    destinationRecoveryPathExists: existsSync(`${markerPath}.orca-drain-destination-path`),
    sessionCommitMarkerExists: existsSync(`${markerPath}.orca-drain-session-commit`)
  }
}
