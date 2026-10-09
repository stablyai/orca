import { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { createWslProcessGroupTermination } from './wsl-process-group-termination'
import { runProcess } from '../../shared/child-process/run-process'

describe('WSL process-group termination', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ code: 0, timedOut: false })
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
    await expect(termination.signal(new ChildProcess())).resolves.toBe(false)
    termination.observeStderr?.(Buffer.from('21:123456\n'))

    await expect(termination.force(new ChildProcess())).resolves.toBe(true)

    const spec = runWslProcessMock.mock.calls[0]?.[0]
    expect(spec.script).toContain('kill -KILL')
    expect(spec.args).toEqual(['4321', '123456'])
    expect(spec.script.indexOf('/proc/$_orca_group/stat')).toBeLessThan(
      spec.script.indexOf('kill -KILL')
    )
    expect(spec.script).toContain('[ "$3" = "$_orca_group" ]')
    expect(spec.script).toContain('[ "$4" = "$_orca_group" ]')
    expect(spec.script).toContain('[ "${20}" = "$_orca_start" ]')
  })

  it('kills the group through the WSL runner, never a raw wsl.exe spawn', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321:123456\n`))

    await termination.signal(new ChildProcess())

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

    await expect(termination.signal(new ChildProcess())).resolves.toBe(false)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('reports failure when the guest kill times out', async () => {
    runWslProcessMock.mockResolvedValue({ code: null, timedOut: true })
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321:123456\n`))

    await expect(termination.force(new ChildProcess())).resolves.toBe(false)
  })

  it('retains the guest identity from a large coalesced stderr chunk', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321:123456\n${'x'.repeat(1_024)}`))

    await expect(termination.signal(new ChildProcess())).resolves.toBe(true)
    expect(runWslProcessMock.mock.calls[0]?.[0]?.args).toEqual(['4321', '123456'])
  })

  it('rejects a PID-only or malformed ownership marker', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const marker = termination
      .wrapGuestArgs(['git', 'fetch'])
      .join(' ')
      .match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(`${marker}4321\n${marker}4321:invalid\n`)
    await expect(termination.force(new ChildProcess())).resolves.toBe(false)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('does not claim success when the guest rejects stale ownership', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const marker = termination
      .wrapGuestArgs(['git', 'fetch'])
      .join(' ')
      .match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(`${marker}4321:123456\n`)
    runWslProcessMock.mockResolvedValue({ code: 1, timedOut: false })
    await expect(termination.force(new ChildProcess())).resolves.toBe(false)
  })

  it.skipIf(process.platform !== 'linux').each(['matching', 'stale'] as const)(
    'checks real Linux process ownership with a harmless kill stub for %s identity',
    async (identity) => {
      const termination = createWslProcessGroupTermination('Ubuntu')
      const marker = termination
        .wrapGuestArgs(['git', 'fetch'])
        .join(' ')
        .match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
      termination.observeStderr?.(`${marker}4321:123456\n`)
      runWslProcessMock.mockImplementation(async (spec) =>
        runProcess({
          program: 'sh',
          args: [
            '-c',
            [
              'kill() { [ "$1" = "-0" ] && return 1; printf "SIGNAL_REQUEST\\n"; return 0; }',
              '_orca_stat=$(cat "/proc/$$/stat"); _orca_stat=${_orca_stat##*) }; set -- $_orca_stat',
              identity === 'matching' ? 'set -- "$$" "${20}"' : 'set -- "$$" 0',
              spec.script
            ].join('\n')
          ],
          timeoutMs: 2000,
          terminationBarrier: true
        })
      )
      expect(await termination.force(new ChildProcess())).toBe(identity === 'matching')
      const result = await runWslProcessMock.mock.results[0]?.value
      expect(result.stdout.includes('SIGNAL_REQUEST')).toBe(identity === 'matching')
    }
  )
})
