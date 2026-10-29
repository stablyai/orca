import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'

const { runWslProcessMock, readWslDistroRunningStateMock } = vi.hoisted(() => ({
  runWslProcessMock: vi.fn(),
  readWslDistroRunningStateMock: vi.fn()
}))

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

import { createWslProcessGroupTermination } from './wsl-process-group-termination'

describe('WSL process-group termination', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ code: 0, timedOut: false })
    // Windows CI runs the real gate; these cases kill in a running distro.
    readWslDistroRunningStateMock.mockReset().mockResolvedValue('running')
  })

  it('wraps the guest command in a reported process group', () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const args = termination.wrapGuestArgs(['git', 'fetch'])

    expect(args.slice(0, 2)).toEqual(['sh', '-c'])
    expect(args.slice(-2)).toEqual(['git', 'fetch'])
    expect(args.join(' ')).toContain('__ORCA_WSL_PROCESS_GROUP_')
    expect(args[2]).toContain('setsid --wait sh -c')
  })

  it('runs the guest command unwrapped where setsid --wait is unsupported', () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const script = termination.wrapGuestArgs(['git', 'fetch'])[2] ?? ''

    expect(script).toContain('if setsid --wait true 2>/dev/null; then')
    expect(script.trimEnd().endsWith('exec "$@"')).toBe(true)
  })

  it('forces and verifies the reported guest process group', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}43`))
    // The marker line is still truncated; committing 43 would target a stranger.
    await expect(termination.signal({} as ChildProcess)).resolves.toBe(false)
    termination.observeStderr?.(Buffer.from('21\n'))

    await expect(termination.force({} as ChildProcess)).resolves.toBe(true)

    const spec = runWslProcessMock.mock.calls[0]?.[0]
    expect(spec.script).toContain('kill -KILL')
    expect(spec.args).toEqual(['4321'])
  })

  it('kills the group through the WSL runner, never a raw wsl.exe spawn', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321\n`))

    await termination.signal({} as ChildProcess)

    const spec = runWslProcessMock.mock.calls[0]?.[0]
    expect(spec.distro).toBe('Ubuntu')
    // The runner picks the shell; a payload of plain POSIX must not pin bash.
    expect(spec.program).toBeUndefined()
    expect(spec.shell).toBeUndefined()
    // The kill reads no login environment, so it must not pay the probe.
    expect(spec.loginPath).toBe('none')
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.script).toContain('kill -TERM')
  })

  it('does not claim termination before the guest reports its identity', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')

    await expect(termination.signal({} as ChildProcess)).resolves.toBe(false)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('reports failure when the guest kill times out', async () => {
    runWslProcessMock.mockResolvedValue({ code: null, timedOut: true })
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321\n`))

    await expect(termination.force({} as ChildProcess)).resolves.toBe(false)
  })

  it('retains the guest identity from a large coalesced stderr chunk', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321\n${'x'.repeat(1_024)}`))

    await expect(termination.signal({} as ChildProcess)).resolves.toBe(true)
    expect(runWslProcessMock.mock.calls[0]?.[0]?.args).toEqual(['4321'])
  })

  describe('on Windows (E9)', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guest barrier never reads the host child.
    const child = {} as ChildProcess

    function reportedGroup(): ReturnType<typeof createWslProcessGroupTermination> {
      const termination = createWslProcessGroupTermination('Ubuntu')
      const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
      const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
      termination.observeStderr?.(Buffer.from(`${marker}4321\n`))
      return termination
    }

    it('treats a group in a stopped distro as gone instead of booting it to kill', async () => {
      readWslDistroRunningStateMock.mockResolvedValue('stopped')
      await expect(reportedGroup().force(child)).resolves.toBe(true)
      expect(runWslProcessMock).not.toHaveBeenCalled()
    })

    it('claims nothing when WSL cannot say whether the distro runs', async () => {
      readWslDistroRunningStateMock.mockResolvedValue('unverifiable')
      await expect(reportedGroup().signal(child)).resolves.toBe(false)
      expect(runWslProcessMock).not.toHaveBeenCalled()
    })

    it('trusts a stop only from a probe started after the guest proved it ran', async () => {
      readWslDistroRunningStateMock.mockResolvedValue('stopped')
      const before = performance.now()
      const termination = reportedGroup()
      await termination.force(child)
      const [distro, options] = readWslDistroRunningStateMock.mock.lastCall ?? []
      expect(distro).toBe('Ubuntu')
      expect(options?.startedAfter).toBeGreaterThanOrEqual(before)
    })

    it('kills in a running distro as before', async () => {
      readWslDistroRunningStateMock.mockResolvedValue('running')
      await expect(reportedGroup().signal(child)).resolves.toBe(true)
      expect(runWslProcessMock).toHaveBeenCalledOnce()
    })
  })
})
