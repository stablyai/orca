import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withGitAdmission } from './git-spawn'
import {
  admitWslGit,
  resetWslGitAdmissionForTests,
  setLocalGitRuntimeRouter,
  WslGitSkippedError
} from './local-git-runtime-route'

const originalPlatform = process.platform
const CWD = String.raw`C:\wsl-project`

function failingChild(stderr: string): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new EventEmitter() })
  setTimeout(() => {
    child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', 1, null)
  }, 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: withGitAdmission uses only pid, stderr and the error/close events.
  return child as unknown as ChildProcess
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  setLocalGitRuntimeRouter(null)
  resetWslGitAdmissionForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

async function spawnAndClose(stderr: string, wslDistro?: string): Promise<void> {
  const child = await withGitAdmission(
    ['status'],
    { cwd: CWD, ...(wslDistro ? { wslDistro } : {}) },
    () => failingChild(stderr)
  )
  await new Promise((resolve) => child.once('close', resolve))
}

describe('withGitAdmission and a missing distro', () => {
  it('records a spawned WSL Git that reports its distro missing, so the next call fails at once', async () => {
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    await spawnAndClose('There is no distribution with the supplied name.\n')
    await expect(admitWslGit({ cwd: CWD, wslDistro: 'Ubuntu' })).rejects.toBeInstanceOf(
      WslGitSkippedError
    )
  })

  it('records nothing for an ordinary Git failure', async () => {
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    await spawnAndClose('fatal: not a git repository\n')
    expect(admitWslGit({ cwd: CWD, wslDistro: 'Ubuntu' })).toBeNull()
  })

  it('records nothing with the router off, even for an explicit distro', async () => {
    await spawnAndClose('There is no distribution with the supplied name.\n', 'Ubuntu')
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    expect(admitWslGit({ cwd: CWD, wslDistro: 'Ubuntu' })).toBeNull()
  })
})
