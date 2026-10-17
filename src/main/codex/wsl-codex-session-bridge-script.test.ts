import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWslCodexSessionBridgeShellCommand } from './wsl-codex-session-bridge-script'

const OLDER = 'rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'
const NEWER = 'rollout-2026-09-02T10-00-00-22222222-2222-4222-8222-222222222222.jsonl'

let root: string
let sourceSessionsRoot: string
let managedHome: string
let pendingRoot: string

function writeRollout(sessionsRoot: string, day: string, name: string): string {
  const path = join(sessionsRoot, day, name)
  mkdirSync(join(sessionsRoot, day), { recursive: true })
  writeFileSync(path, '{}\n')
  return path
}

function runBridge(options: { markers?: boolean } = {}): string[] {
  const command = buildWslCodexSessionBridgeShellCommand({
    systemSessionsRoot: sourceSessionsRoot,
    managedSessionsRoot: join(managedHome, 'sessions'),
    ...(options.markers === false ? {} : { indexPendingRoot: pendingRoot })
  })
  return execFileSync('/bin/bash', ['-c', command]).toString().trim().split('\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-wsl-bridge-markers-'))
  sourceSessionsRoot = join(root, 'source', 'sessions')
  managedHome = join(root, 'managed')
  pendingRoot = join(managedHome, '.orca-index-pending')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('WSL session bridge index markers', () => {
  it('marks each newly linked rollout and reports the markers newest first', () => {
    const source = writeRollout(sourceSessionsRoot, '2026/09/01', OLDER)
    writeRollout(sourceSessionsRoot, '2026/09/02', NEWER)
    writeRollout(sourceSessionsRoot, '2026/09/02', 'notes.jsonl')

    expect(runBridge()).toEqual([
      NEWER,
      OLDER,
      '{"scannedFiles":3,"linkedFiles":3,"pendingFiles":2}'
    ])
    expect(statSync(source).nlink).toBe(2)
    expect(readdirSync(pendingRoot).sort()).toEqual([OLDER, NEWER])
  })

  it('keeps reporting unsettled markers without marking already-linked rollouts again', () => {
    writeRollout(sourceSessionsRoot, '2026/09/01', OLDER)
    runBridge()
    rmSync(join(pendingRoot, OLDER))
    writeRollout(sourceSessionsRoot, '2026/09/02', NEWER)

    expect(runBridge()).toEqual([NEWER, '{"scannedFiles":2,"linkedFiles":1,"pendingFiles":1}'])
  })

  it('reports leftover markers when the history source is gone', () => {
    writeRollout(sourceSessionsRoot, '2026/09/01', OLDER)
    runBridge()
    rmSync(join(root, 'source'), { recursive: true })

    expect(runBridge()).toEqual([OLDER, '{"scannedFiles":0,"linkedFiles":0,"pendingFiles":1}'])
  })

  it('drops the marker of a rollout it could not link and still prints the summary', () => {
    writeRollout(sourceSessionsRoot, '2026/09/01', OLDER)
    writeRollout(sourceSessionsRoot, '2026/09/02', NEWER)
    const binDir = join(root, 'bin')
    mkdirSync(binDir)
    const lnShimPath = join(binDir, 'ln')
    writeFileSync(
      lnShimPath,
      `#!/bin/sh\nif [ "$3" = "$BLOCKED_TARGET" ]; then\n  exit 1\nfi\nexec /bin/ln "$@"\n`
    )
    chmodSync(lnShimPath, 0o755)
    const command = buildWslCodexSessionBridgeShellCommand({
      systemSessionsRoot: sourceSessionsRoot,
      managedSessionsRoot: join(managedHome, 'sessions'),
      indexPendingRoot: pendingRoot
    })

    const result = spawnSync('/bin/bash', ['-c', command], {
      env: {
        ...process.env,
        BLOCKED_TARGET: join(managedHome, 'sessions', '2026', '09', '02', NEWER),
        PATH: `${binDir}:${process.env.PATH ?? ''}`
      },
      encoding: 'utf8'
    })

    expect(result.status).toBe(1)
    const stdout = result.stdout
    expect(stdout.trim().split('\n')).toEqual([
      OLDER,
      '{"scannedFiles":2,"linkedFiles":1,"pendingFiles":1}'
    ])
    expect(readdirSync(pendingRoot)).toEqual([OLDER])
  })

  it('leaves the marker-free output unchanged for callers that do not ask for markers', () => {
    writeRollout(sourceSessionsRoot, '2026/09/01', OLDER)

    expect(runBridge({ markers: false })).toEqual(['{"scannedFiles":1,"linkedFiles":1}'])
    expect(existsSync(pendingRoot)).toBe(false)
  })
})
