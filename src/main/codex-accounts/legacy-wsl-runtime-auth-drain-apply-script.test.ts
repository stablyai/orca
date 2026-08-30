import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'
import { FINALIZE_ABSENT_AUTH_SCRIPT } from './legacy-wsl-runtime-auth-drain-scripts'

const isWindows = process.platform === 'win32'
const SOURCE = '{"tokens":{"expires_at":2000}}\n'
const TARGET = '{"tokens":{"expires_at":1000}}\n'
const NEWER = '{"tokens":{"expires_at":3000}}\n'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
type ApplyOutcome = {
  firstStatus?: number
  marker: boolean
  quarantine?: string | null
  markerKind?: 'file' | 'other' | 'symlink'
  source: string | null
  status: number
  target: string
}

function runApply(
  options: {
    deleteSource?: boolean
    crashBeforeCommit?: boolean
    promoteAuth?: boolean
    retry?: boolean
    rewriteAfterHashCall?: number
    rewriteBeforeDelete?: boolean
    rewriteSourceBeforeDelete?: boolean
    symlinkMarkerDirectoryBeforeCommit?: boolean
    symlinkMarkerBeforeDelete?: boolean
    symlinkSource?: boolean
    symlinkTarget?: boolean
  } = {}
): ApplyOutcome {
  const root = mkdtempSync(join(tmpdir(), 'orca-drain-race-'))
  const legacy = join(root, 'legacy')
  const target = join(root, 'target')
  const bin = join(root, 'bin')
  mkdirSync(legacy)
  mkdirSync(target)
  mkdirSync(bin)
  const sourcePath = join(legacy, 'auth.json')
  const targetPath = join(target, 'auth.json')
  const marker = join(root, 'marker')
  writeFileSync(sourcePath, SOURCE)
  writeFileSync(targetPath, TARGET)
  if (options.symlinkSource) {
    const sourceBytes = join(root, 'source-bytes')
    writeFileSync(sourceBytes, SOURCE)
    rmSync(sourcePath)
    symlinkSync(sourceBytes, sourcePath)
  }
  if (options.symlinkTarget) {
    const targetBytes = join(root, 'target-bytes')
    writeFileSync(targetBytes, TARGET)
    rmSync(targetPath)
    symlinkSync(targetBytes, targetPath)
  }
  const counter = join(root, 'counter')
  writeFileSync(counter, '0')
  const shim = join(bin, 'sha256sum')
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs=require('node:fs'); const crypto=require('node:crypto'); const file=process.argv.at(-1)
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+file+'\\n')
const n=Number(fs.readFileSync(process.env.COUNTER))+1; fs.writeFileSync(process.env.COUNTER,String(n))
if(process.env.REWRITE && n===Number(process.env.REWRITE)) fs.writeFileSync(process.env.TARGET, process.env.BYTES)
`
  )
  chmodSync(shim, 0o755)
  const statShim = join(bin, 'stat')
  writeFileSync(
    statShim,
    `#!/usr/bin/env node
const fs = require('node:fs')
const mode = fs.statSync(process.argv.at(-1)).mode & 0o777
process.stdout.write(mode.toString(8) + '\\n')
`
  )
  chmodSync(statShim, 0o755)
  const mvShim = join(bin, 'mv')
  writeFileSync(
    mvShim,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const retiresSource = args.at(-2)?.endsWith('/legacy/auth.json')
const commitsMarker = args.at(-1) === process.env.MARKER && args.at(-2)?.includes('.orca-drain-')
if (process.env.REWRITE_BEFORE_DELETE === '1' && retiresSource) {
  const replacement = process.env.TARGET + '.replacement'
  fs.writeFileSync(replacement, process.env.BYTES)
  fs.renameSync(replacement, process.env.TARGET)
}
if (process.env.REWRITE_SOURCE_BEFORE_DELETE === '1' && retiresSource) {
  const source = args.at(-2)
  const replacement = source + '.replacement'
  fs.writeFileSync(replacement, process.env.BYTES)
  fs.renameSync(replacement, source)
}
if (process.env.SYMLINK_MARKER_BEFORE_DELETE === '1' && retiresSource) {
  fs.writeFileSync(process.env.MARKER_TARGET, '{"completed":true}\\n')
  fs.symlinkSync(process.env.MARKER_TARGET, process.env.MARKER)
}
if (process.env.SYMLINK_MARKER_DIRECTORY_BEFORE_COMMIT === '1' && commitsMarker) {
  fs.mkdirSync(process.env.MARKER_DIRECTORY)
  fs.symlinkSync(process.env.MARKER_DIRECTORY, process.env.MARKER)
}
if (args.includes('-T')) {
  const target = args.at(-1)
  let targetStat
  try { targetStat = fs.lstatSync(target) } catch {}
  if (targetStat) {
    if (targetStat.isSymbolicLink()) fs.unlinkSync(target)
    else if (targetStat.isDirectory()) process.exit(1)
  }
  args.splice(args.indexOf('-T'), 1)
}
const result = spawnSync('/bin/mv', args, { stdio: 'inherit' })
if (result.status === 0 && process.env.CRASH_BEFORE_COMMIT === '1' && retiresSource) {
  process.kill(process.ppid, 'SIGKILL')
}
process.exit(result.status ?? 1)
`
  )
  chmodSync(mvShim, 0o755)
  const applyArgs = [
    '-c',
    _internals.applyLegacyAuthScript,
    'sh',
    legacy,
    join(root, 'active'),
    marker,
    target,
    sha256(SOURCE),
    sha256(TARGET),
    options.promoteAuth ? '1' : '0',
    options.deleteSource === false ? '0' : '1',
    'missing'
  ]
  const apply = (crashBeforeCommit: boolean, rewriteSourceBeforeDelete: boolean): number => {
    try {
      execFileSync('/bin/sh', applyArgs, {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          COUNTER: counter,
          CRASH_BEFORE_COMMIT: crashBeforeCommit ? '1' : '',
          REWRITE: options.rewriteAfterHashCall ? String(options.rewriteAfterHashCall) : '',
          REWRITE_BEFORE_DELETE: options.rewriteBeforeDelete ? '1' : '',
          REWRITE_SOURCE_BEFORE_DELETE: rewriteSourceBeforeDelete ? '1' : '',
          SYMLINK_MARKER_BEFORE_DELETE: options.symlinkMarkerBeforeDelete ? '1' : '',
          SYMLINK_MARKER_DIRECTORY_BEFORE_COMMIT: options.symlinkMarkerDirectoryBeforeCommit
            ? '1'
            : '',
          MARKER: marker,
          MARKER_DIRECTORY: join(root, 'marker-directory'),
          MARKER_TARGET: join(root, 'marker-target'),
          TARGET: targetPath,
          BYTES: NEWER
        },
        stdio: 'ignore'
      })
      return 0
    } catch (error) {
      return (error as { status?: number }).status ?? -1
    }
  }
  const firstStatus = apply(
    Boolean(options.crashBeforeCommit),
    Boolean(options.rewriteSourceBeforeDelete)
  )
  let status = firstStatus
  if (options.retry) {
    execFileSync(
      '/bin/sh',
      ['-c', _internals.inspectLegacyAuthScript, 'sh', legacy, join(root, 'active'), marker],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: 'ignore' }
    )
    writeFileSync(counter, '0')
    status = apply(false, false)
  }
  const outcome = {
    status,
    source: existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : null,
    target: readFileSync(targetPath, 'utf8'),
    marker: existsSync(marker)
  }
  const quarantine = `${marker}.orca-drain-live-source`
  const quarantineContents = existsSync(quarantine) ? readFileSync(quarantine, 'utf8') : null
  const markerKind = existsSync(marker)
    ? lstatSync(marker).isSymbolicLink()
      ? 'symlink'
      : lstatSync(marker).isFile()
        ? 'file'
        : 'other'
    : undefined
  rmSync(root, { recursive: true, force: true })
  return {
    ...outcome,
    ...(options.retry ? { firstStatus } : {}),
    ...(options.symlinkMarkerDirectoryBeforeCommit ? { markerKind } : {}),
    ...(options.rewriteSourceBeforeDelete ? { quarantine: quarantineContents } : {})
  }
}

describe.skipIf(isWindows)('legacy WSL auth drain race guard', () => {
  it('checks recovery modes without root write-access semantics', () => {
    expect(_internals.applyLegacyAuthScript).not.toContain('[ ! -w ')
    expect(_internals.applyLegacyAuthScript).toContain("stat -c '%a'")
  })
  it('retires an unchanged source', () =>
    expect(runApply()).toEqual({ status: 0, source: null, target: TARGET, marker: true }))
  it('promotes the verified source before retiring it', () =>
    expect(runApply({ promoteAuth: true })).toEqual({
      status: 0,
      source: null,
      target: SOURCE,
      marker: true
    }))
  it('retains the source and marker while a legacy pane is live', () =>
    expect(runApply({ deleteSource: false, promoteAuth: true })).toEqual({
      status: 0,
      source: SOURCE,
      target: SOURCE,
      marker: false
    }))
  it('retains source when destination is rewritten during validation', () => {
    const outcome = runApply({ rewriteAfterHashCall: 3 })
    expect(outcome.status).toBe(45)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.target).toBe(NEWER)
    expect(outcome.marker).toBe(false)
  })
  it('retains source when destination is rewritten immediately before deletion', () => {
    const outcome = runApply({ rewriteBeforeDelete: true })
    expect(outcome.status).not.toBe(0)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.target).toBe(NEWER)
    expect(outcome.marker).toBe(false)
  })
  it('rejects a symlinked source auth file', () => {
    const outcome = runApply({ symlinkSource: true })
    expect(outcome.status).toBe(35)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.marker).toBe(false)
  })
  it('rejects a symlinked destination auth file', () => {
    const outcome = runApply({ symlinkTarget: true })
    expect(outcome.status).toBe(36)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.marker).toBe(false)
  })
  it('restores verified source bytes when the source path is atomically replaced', () => {
    const outcome = runApply({ rewriteSourceBeforeDelete: true })
    expect(outcome.status).toBe(40)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.quarantine).toBe(NEWER)
    expect(outcome.marker).toBe(false)
  })
  it('does not accept a symlink marker while recovering a failed source retirement', () => {
    const outcome = runApply({ rewriteSourceBeforeDelete: true, symlinkMarkerBeforeDelete: true })
    expect(outcome.status).toBe(40)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.quarantine).toBe(NEWER)
  })
  it('commits a real marker when the path becomes a symlink to a directory', () => {
    const outcome = runApply({ symlinkMarkerDirectoryBeforeCommit: true })
    expect(outcome.status).toBe(0)
    expect(outcome.source).toBeNull()
    expect(outcome.markerKind).toBe('file')
  })
  it('preserves conflicting quarantined source bytes across a retry', () => {
    const outcome = runApply({ rewriteSourceBeforeDelete: true, retry: true })
    expect(outcome.firstStatus).toBe(40)
    expect(outcome.status).toBe(40)
    expect(outcome.source).toBe(SOURCE)
    expect(outcome.quarantine).toBe(NEWER)
    expect(outcome.marker).toBe(false)
  })
  it('recovers and retries after interruption before the completion marker', () => {
    const outcome = runApply({ crashBeforeCommit: true, retry: true })
    expect(outcome.firstStatus).not.toBe(0)
    expect(outcome.status).toBe(0)
    expect(outcome.source).toBeNull()
    expect(outcome.target).toBe(TARGET)
    expect(outcome.marker).toBe(true)
  })
})

describe.skipIf(isWindows)('legacy WSL auth drain absent-source finalization', () => {
  it('rejects a symlinked completion marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-drain-finalize-'))
    const legacy = join(root, 'legacy')
    const markerTarget = join(root, 'marker-target')
    const marker = join(root, 'marker')
    mkdirSync(legacy)
    writeFileSync(markerTarget, '{"completed":true}\n')
    symlinkSync(markerTarget, marker)

    let status = 0
    try {
      execFileSync(
        '/bin/sh',
        ['-c', FINALIZE_ABSENT_AUTH_SCRIPT, 'sh', legacy, join(root, 'active'), marker],
        { stdio: 'ignore' }
      )
    } catch (error) {
      status = (error as { status?: number }).status ?? -1
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    expect(status).toBe(46)
  })
})
