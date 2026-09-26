import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))

import { createFakeSpawnedChild } from '../../../shared/child-process/__fixtures__/fake-spawned-child'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../../crash-reporting/crash-breadcrumb-store'
import {
  hostProcessSpawnRefusalDetails,
  resetHostProcessSpawnRefusalForTest
} from '../../crash-reporting/host-process-spawn-refusal'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { execFileCapture, execFileCaptureToTermination } from './exec-file-capture'
import { withGitAdmission } from './git-spawn'
import { gitStreamStdout } from './git-stream-stdout'
import { GitAdmissionScheduler, _resetGitAdmissionForTests } from './git-subprocess-admission'

/**
 * The promotion path, not the classifier.
 *
 * Every other test in this feature calls `noteHostProcessSpawnFailure` itself,
 * so all three production call sites could be deleted with the suite still
 * green - and a refused spawn would silently go back to being invisible in
 * crash reports, which is the whole blind spot the feature exists to close.
 */

type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void

function spawnRefusal(code: string, program: string): Error {
  return Object.assign(new Error(`spawn ${program} ${code}`), {
    code,
    syscall: `spawn ${program}`
  })
}

// What Node throws out of `spawn()`: `errnoException(err, 'spawn')`, whose syscall
// carries no program, so only the call site can still name the refused binary.
function synchronousSpawnRefusal(code: string): Error {
  return Object.assign(new Error(`spawn ${code}`), { code, syscall: 'spawn' })
}

// pid 0, the way these suites already spell "never got a pid".
function refusedChild(spawnfile = 'git'): ChildProcess {
  return createFakeSpawnedChild(0, spawnfile)
}

function refusalCrumbs(): unknown[] {
  return getCrashBreadcrumbSnapshot().filter((crumb) => crumb.name === 'host_process_spawn_refused')
}

beforeEach(() => {
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
  _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 4, generalHeadroom: 4 }))
  clearCrashBreadcrumbsForTest()
  resetHostProcessSpawnRefusalForTest()
  execFileMock.mockReset()
  spawnMock.mockReset()
})

afterEach(() => {
  _resetGitAdmissionForTests()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetHostProcessSpawnRefusalForTest()
})

describe('a refused git spawn reaches the crash report', () => {
  it('promotes an execFileCapture refusal', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, done: ExecCallback) => {
        queueMicrotask(() => done(spawnRefusal('EMFILE', 'git.exe'), '', ''))
        return refusedChild('git.exe')
      }
    )

    await expect(
      execFileCapture('C:\\Program Files\\Git\\cmd\\git.exe', ['status'], { cwd: '/repo' })
    ).rejects.toMatchObject({ code: 'EMFILE' })

    expect(refusalCrumbs()).toEqual([
      expect.objectContaining({
        name: 'host_process_spawn_refused',
        data: expect.objectContaining({ program: 'git.exe', marker: 'descriptors-exhausted' })
      })
    ])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toMatchObject({
      hostProcessSpawnRefusedCount: 1,
      hostProcessSpawnRefusedMarkers: 'descriptors-exhausted',
      hostProcessSpawnRefusedPrograms: 'git.exe'
    })
  })

  it('promotes a runProcess refusal under the termination barrier', async () => {
    const spawned: ChildProcess[] = []
    spawnMock.mockImplementation(() => {
      const child = refusedChild()
      spawned.push(child)
      return child
    })

    const pending = execFileCaptureToTermination('git', ['status'], { cwd: '/repo' })
    spawned[0]!.emit('error', spawnRefusal('EAGAIN', 'git'))

    await expect(pending).rejects.toMatchObject({ code: 'EAGAIN' })
    expect(refusalCrumbs()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ program: 'git', marker: 'fork-eagain' })
      })
    ])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toMatchObject({
      hostProcessSpawnRefusedCount: 1
    })
  })

  it('promotes a withGitAdmission refusal under the binary that was actually refused', async () => {
    const child = refusedChild('C:\\Windows\\System32\\wsl.exe')
    await withGitAdmission(['status'], { cwd: '/repo' }, () => child)

    // EAGAIN, not UNKNOWN: this is the half Node really delivers as an event.
    child.emit('error', spawnRefusal('EAGAIN', 'wsl.exe'))

    expect(refusalCrumbs()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ program: 'wsl.exe', marker: 'fork-eagain' })
      })
    ])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toMatchObject({
      hostProcessSpawnRefusedCount: 1,
      hostProcessSpawnRefusedPrograms: 'wsl.exe'
    })
  })

  /**
   * Node emits 'error' for exactly EACCES, EAGAIN, EMFILE, ENFILE and ENOENT and
   * throws every other code straight out of `spawn()`. UNKNOWN and ENOMEM - the two
   * a Windows commit-limit refusal produces, and the a8b4e777 signal - therefore
   * never reach a child listener, because no child object is ever returned.
   */
  it.each([
    ['UNKNOWN', 'spawn-unknown'],
    ['ENOMEM', 'not-enough-memory']
  ])('promotes a %s refusal Node throws synchronously', async (code, marker) => {
    spawnMock.mockImplementation(() => {
      throw synchronousSpawnRefusal(code)
    })

    await expect(withGitAdmission(['status'], { cwd: '/repo' })).rejects.toMatchObject({ code })

    expect(refusalCrumbs()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ program: 'git', marker }) })
    ])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toMatchObject({
      hostProcessSpawnRefusedCount: 1,
      hostProcessSpawnRefusedMarkers: marker,
      hostProcessSpawnRefusedPrograms: 'git'
    })
  })

  it('promotes a streamed git refusal, which has no admission wrapper to record for it', async () => {
    let spawned: ChildProcess | undefined
    spawnMock.mockImplementation(() => {
      spawned = refusedChild()
      return spawned
    })

    const pending = gitStreamStdout(['status'], { cwd: '/repo', onStdout: () => {} })
    await vi.waitUntil(() => spawned !== undefined)
    spawned?.emit('error', spawnRefusal('EAGAIN', 'git'))

    await expect(pending).rejects.toMatchObject({ code: 'EAGAIN' })
    expect(refusalCrumbs()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ program: 'git', marker: 'fork-eagain' })
      })
    ])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toMatchObject({
      hostProcessSpawnRefusedCount: 1
    })
  })

  it('leaves a refusal code that did not come from a spawn out of the report', async () => {
    // Node's child `'error'` event is not spawn-only - a failed kill or send lands
    // there too - so the production path has to gate on the syscall, not the code.
    // EMFILE on an open() is real host pressure and still not the host refusing to
    // create a process, which is the only thing this crumb claims.
    spawnMock.mockImplementation(() => refusedChild())
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, done: ExecCallback) => {
      const child = createFakeSpawnedChild(4242)
      queueMicrotask(() =>
        done(
          Object.assign(new Error('EMFILE: too many open files'), {
            code: 'EMFILE',
            syscall: 'open'
          }),
          '',
          ''
        )
      )
      return child
    })

    await expect(execFileCapture('git', ['status'], { cwd: '/repo' })).rejects.toMatchObject({
      code: 'EMFILE'
    })

    expect(refusalCrumbs()).toEqual([])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toEqual({
      hostProcessSpawnRefusedCount: 0
    })
  })

  it('leaves an ordinary non-zero git exit out of the report', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, done: ExecCallback) => {
        // execFile puts the child's whole stderr in the message it builds.
        queueMicrotask(() =>
          done(
            Object.assign(
              new Error('Command failed: git push\nremote: ERROR_COMMITMENT_LIMIT on the server\n'),
              { code: 128 }
            ),
            '',
            'remote: ERROR_COMMITMENT_LIMIT on the server\n'
          )
        )
        return createFakeSpawnedChild(4242)
      }
    )

    await expect(execFileCapture('git', ['push'], { cwd: '/repo' })).rejects.toMatchObject({
      code: 128
    })

    expect(refusalCrumbs()).toEqual([])
    expect(hostProcessSpawnRefusalDetails(Date.now())).toEqual({
      hostProcessSpawnRefusedCount: 0
    })
  })
})
