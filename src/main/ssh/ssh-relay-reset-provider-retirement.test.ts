import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { captureSshResetProviderRetirement } from './ssh-relay-reset-provider-retirement'
import {
  getSshPtyProvider,
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  sshProvidersByGeneration
} from '../ipc/pty/provider/registry'
import {
  getSshFilesystemProvider,
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  getSshGitProvider,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../providers/ssh-git-dispatch'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose()
  }
})
let generation = 5000000
function fixture() {
  const targetId = randomUUID()
  const providerGeneration = ++generation
  const pty = { providerGeneration, dispose: vi.fn() }
  const filesystem = { dispose: vi.fn() }
  const git = {}
  registerSshPtyProvider(targetId, pty as never)
  registerSshFilesystemProvider(targetId, filesystem as never)
  registerSshGitProvider(targetId, git as never)
  cleanup.push(() => {
    unregisterSshPtyProvider(targetId)
    sshProvidersByGeneration.delete(providerGeneration)
    unregisterSshFilesystemProvider(targetId)
    unregisterSshGitProvider(targetId)
  })
  const retirement = captureSshResetProviderRetirement(targetId, providerGeneration)
  return { targetId, pty, filesystem, git, retirement }
}

it('removes the entire cohort before callbacks and retries exact cleanup', () => {
  const f = fixture()
  let absent = false
  f.pty.dispose.mockImplementation(() => {
    absent =
      !getSshPtyProvider(f.targetId) &&
      !getSshFilesystemProvider(f.targetId) &&
      !getSshGitProvider(f.targetId)
  })
  f.filesystem.dispose.mockImplementationOnce(() => {
    throw new Error('retry')
  })
  expect(() => f.retirement.retire(() => {})).toThrow('retry')
  expect(absent).toBe(true)
  expect(() => f.retirement.assertRetired()).toThrow('not retired')
  f.retirement.retire(() => {})
  f.retirement.assertRetired()
  expect(f.pty.dispose).toHaveBeenCalledTimes(1)
  expect(f.filesystem.dispose).toHaveBeenCalledTimes(2)
})

it.each(['pty', 'filesystem', 'git', 'generation'] as const)(
  'refuses changed %s before any cleanup',
  (changed) => {
    const f = fixture()
    if (changed === 'pty') {
      registerSshPtyProvider(f.targetId, {} as never)
    }
    if (changed === 'filesystem') {
      registerSshFilesystemProvider(f.targetId, {} as never)
    }
    if (changed === 'git') {
      registerSshGitProvider(f.targetId, {} as never)
    }
    if (changed === 'generation') {
      registerSshGitProvider(f.targetId, f.git as never)
    }
    expect(() => f.retirement.retire(() => {})).toThrow('changed')
    expect(f.pty.dispose).not.toHaveBeenCalled()
    expect(f.filesystem.dispose).not.toHaveBeenCalled()
  }
)

it('preserves a replacement registered reentrantly during captured disposal', () => {
  const f = fixture()
  const replacement = { dispose: vi.fn() }
  f.pty.dispose.mockImplementation(() =>
    registerSshFilesystemProvider(f.targetId, replacement as never)
  )
  expect(() => f.retirement.retire(() => {})).toThrow('changed')
  expect(getSshFilesystemProvider(f.targetId)).toBe(replacement)
  expect(replacement.dispose).not.toHaveBeenCalled()
  expect(f.filesystem.dispose).not.toHaveBeenCalled()
  expect(() => f.retirement.retire(() => {})).toThrow('changed')
})

it('checks authority before mutation and after callbacks', () => {
  const f = fixture()
  const assertAuthority = vi.fn((): void => {
    throw new Error('authority')
  })
  expect(() => f.retirement.retire(assertAuthority)).toThrow('authority')
  expect(getSshPtyProvider(f.targetId)).toBe(f.pty)
  assertAuthority
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error('authority')
    })
  expect(() => f.retirement.retire(assertAuthority)).toThrow('authority')
  expect(f.pty.dispose).toHaveBeenCalledTimes(1)
  expect(f.filesystem.dispose).not.toHaveBeenCalled()
})
