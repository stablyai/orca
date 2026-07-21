import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectDir = join(import.meta.dirname, '../..')
const patchSource = readFileSync(join(projectDir, 'config/patches/node-pty@1.1.0.patch'), 'utf8')

function patchSection(path) {
  const marker = `diff --git a/${path} b/${path}`
  const start = patchSource.indexOf(marker)
  expect(start, `missing patch section for ${path}`).toBeGreaterThanOrEqual(0)
  const next = patchSource.indexOf('\ndiff --git ', start + marker.length)
  return patchSource.slice(start, next === -1 ? undefined : next)
}

function addedLines(section) {
  return section
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

function patchedLines(section) {
  return section
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith(' ') && !line.startsWith(' diff --git'))
    )
    .map((line) => line.slice(1))
    .join('\n')
}

describe('patched node-pty Windows Job Object contract', () => {
  it('suspends ConPTY children until kill-on-close ownership is configured', () => {
    const native = patchedLines(patchSection('src/win/conpty.cc'))
    const createFlags = native.indexOf(
      'EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |'
    )
    const suspended = native.indexOf('CREATE_SUSPENDED')
    const createJob = native.indexOf('CreateJobObjectW(')
    const killOnClose = native.indexOf('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    const configureJob = native.indexOf('SetInformationJobObject(')
    const assignJob = native.indexOf('AssignProcessToJobObject(')
    const resume = native.indexOf('ResumeThread(')

    for (const index of [
      createFlags,
      suspended,
      createJob,
      killOnClose,
      configureJob,
      assignJob,
      resume
    ]) {
      expect(index).toBeGreaterThanOrEqual(0)
    }
    expect(suspended).toBeGreaterThan(createFlags)
    expect(createJob).toBeGreaterThan(suspended)
    expect(killOnClose).toBeGreaterThan(createJob)
    expect(configureJob).toBeGreaterThan(killOnClose)
    expect(assignJob).toBeGreaterThan(configureJob)
    expect(resume).toBeGreaterThan(assignJob)
  })

  it('keeps Job Object cleanup race-safe and falls back to direct-root termination', () => {
    const native = patchedLines(patchSection('src/win/conpty.cc'))

    expect(native).toContain('std::shared_ptr<pty_baton>')
    expect(native).toContain('std::atomic<HANDLE> hJob')
    expect(native).toContain('hJob.exchange(nullptr)')
    expect(native).toContain('TerminateJobObject(')
    expect(native).toContain('CloseHandle(hJob)')
    expect(native).toContain('bool jobObjectAssigned = false')
    expect(native).toContain('bool jobObjectSetupFailed = false')
    expect(native).toContain('std::mutex hShellMutex')
    expect(native).toMatch(
      /if \(hJob == nullptr &&\s*!handle->jobObjectAssigned &&\s*\(useConptyDll \|\| handle->jobObjectSetupFailed\)\)/
    )
    expect(native).toContain('terminate_shell_process(handle)')
    expect(native).not.toContain('TerminateProcess(handle->hShell')
  })

  it('serializes shell-handle close with fallback termination and preserves resume errors', () => {
    const native = patchedLines(patchSection('src/win/conpty.cc'))
    const closeHelper = native.indexOf('read_exit_code_and_close_shell_handle(')
    const closeLock = native.indexOf(
      'std::lock_guard<std::mutex> lock(baton->hShellMutex)',
      closeHelper
    )
    const getExitCode = native.indexOf('GetExitCodeProcess(', closeLock)
    const closeHandle = native.indexOf('CloseHandle(baton->hShell)', getExitCode)
    const clearHandle = native.indexOf('baton->hShell = nullptr', closeHandle)

    expect(closeHelper).toBeGreaterThanOrEqual(0)
    expect(closeLock).toBeGreaterThan(closeHelper)
    expect(getExitCode).toBeGreaterThan(closeLock)
    expect(closeHandle).toBeGreaterThan(getExitCode)
    expect(clearHandle).toBeGreaterThan(closeHandle)

    const resume = native.indexOf('ResumeThread(')
    const saveError = native.indexOf('const DWORD resumeError = GetLastError()', resume)
    const removeBaton = native.indexOf('remove_pty_baton(handle->id)', saveError)
    const throwSavedError = native.indexOf(
      'errorWithCode(info, "Cannot resume process", resumeError)',
      removeBaton
    )

    expect(resume).toBeGreaterThanOrEqual(0)
    expect(saveError).toBeGreaterThan(resume)
    expect(removeBaton).toBeGreaterThan(saveError)
    expect(throwSavedError).toBeGreaterThan(removeBaton)

    expect(native).not.toContain('assert(remove_pty_baton(')
    expect(native.match(/const bool removed = remove_pty_baton\(/g)).toHaveLength(2)
    expect(native.match(/assert\(removed\);\s*\(void\)removed;/g)).toHaveLength(2)
  })

  it('threads the opt-in through source, compiled JS, native typings, and public typings', () => {
    for (const path of [
      'src/interfaces.ts',
      'src/native.d.ts',
      'src/windowsTerminal.ts',
      'src/windowsPtyAgent.ts',
      'lib/windowsTerminal.js',
      'lib/windowsPtyAgent.js',
      'typings/node-pty.d.ts'
    ]) {
      expect(addedLines(patchSection(path))).toContain('useConptyJobObject')
    }

    const agent = addedLines(patchSection('src/windowsPtyAgent.ts'))
    expect(agent).toContain('if (this._useConptyJobObject || this._useConptyDll)')
    expect(agent).not.toContain('process.kill(this._innerPid)')
  })

  it('forces patched Windows node-pty installs to use build/Release conpty.node', () => {
    for (const scriptName of ['ensure-native-runtime.mjs', 'rebuild-native-deps.mjs']) {
      const source = readFileSync(join(projectDir, 'config/scripts', scriptName), 'utf8')
      expect(source).toContain("process.platform === 'win32' ? 'conpty.node' : 'pty.node'")
      expect(source).not.toMatch(
        /if \((?:process\.platform|rebuildPlatform) === 'win32'\) \{\s*return false\s*\}/
      )
    }
  })
})
