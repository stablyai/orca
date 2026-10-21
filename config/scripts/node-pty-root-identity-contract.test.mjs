import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../patches/node-pty@1.1.0.patch', import.meta.url), 'utf8')
const conpty = patch.split(/^diff --git /m).find((part) => part.startsWith('a/src/win/conpty.cc '))
const added = conpty
  .split('\n')
  .filter((line) => line.startsWith('+'))
  .map((line) => line.slice(1))
  .join('\n')
const reader = added.slice(
  added.indexOf('static Napi::Value PtyGetShellCreationTime('),
  added.indexOf('static Napi::Value PtyTerminateJob(')
)

describe('ConPTY root identity source contract', () => {
  it('reads creation time from the existing handle while holding the exit-watcher lock', () => {
    const lock = reader.indexOf('std::lock_guard<std::mutex> guard(ptyJobMutex)')
    const lookup = reader.indexOf('get_pty_baton_locked(')
    const read = reader.indexOf('GetProcessTimes(handle->hShell,')
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lookup).toBeGreaterThan(lock)
    expect(read).toBeGreaterThan(lookup)
    expect(reader).toContain('handle->hShell == nullptr')
    expect(reader).toContain('handle->shellPid != expectedShellPid')
    expect(reader).not.toContain('OpenProcess(')
  })

  it('keeps native identity available when job assignment failed', () => {
    expect(reader).not.toContain('handle->hJob')
    expect(reader).not.toContain('ownsShell(')
    expect(added).toContain(
      'exports.Set("getShellCreationTime", Napi::Function::New(env, PtyGetShellCreationTime))'
    )
  })

  it('uses the process-table reader’s integer-millisecond FILETIME conversion', () => {
    expect(reader).toContain('WINDOWS_EPOCH_OFFSET_100NS = 116444736000000000ULL')
    expect(reader).toContain('(timestamp.QuadPart - WINDOWS_EPOCH_OFFSET_100NS) / 10000ULL')
  })
})

const require = createRequire(import.meta.url)
const {
  assertNodePtyJobOwnership,
  assertConptyRootIdentityAvailable,
  assertNodePtySourceDeniesMsysBreakaway
} = require('./node-pty-job-ownership.cjs')

describe('ConPTY stable identity build gates', () => {
  it('rejects a cached addon even when all older job functions remain present', () => {
    expect(() =>
      assertNodePtyJobOwnership({
        platform: 'win32',
        nativeName: 'conpty',
        native: { terminateJob() {}, listJobProcessIds() {}, assignCurrentProcessToJob() {} }
      })
    ).toThrow(/missing getShellCreationTime/)
  })

  it('rejects a stale cross-architecture artifact without loading native code', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orca-conpty-identity-')), 'conpty.node')
    writeFileSync(
      path,
      Buffer.concat([Buffer.from('MZ old addon'), Buffer.from('msys-2.0.dll', 'utf16le')])
    )
    expect(() => assertConptyRootIdentityAvailable(path)).toThrow(/lacks getShellCreationTime/)
    writeFileSync(path, Buffer.from('MZ getShellCreationTime'))
    expect(() => assertConptyRootIdentityAvailable(path)).not.toThrow()
  })

  it('requests reinstall before rebuilding older source that already has the MSYS marker', () => {
    const nodePtyDir = mkdtempSync(join(tmpdir(), 'orca-conpty-source-'))
    mkdirSync(join(nodePtyDir, 'src', 'win'), { recursive: true })
    const path = join(nodePtyDir, 'src', 'win', 'conpty.cc')
    writeFileSync(path, 'L"msys-2.0.dll"')
    expect(() => assertNodePtySourceDeniesMsysBreakaway({ nodePtyDir })).toThrow(/pnpm install/)
    writeFileSync(path, 'L"msys-2.0.dll"; exports.Set("getShellCreationTime", reader);')
    expect(() => assertNodePtySourceDeniesMsysBreakaway({ nodePtyDir })).not.toThrow()
  })
})
