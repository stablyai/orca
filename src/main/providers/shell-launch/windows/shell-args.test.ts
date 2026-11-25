import { afterEach, describe, expect, it, vi } from 'vitest'

const { ensureWrappersMock, getBashWrapperArgsMock } = vi.hoisted(() => ({
  ensureWrappersMock: vi.fn(() => true),
  getBashWrapperArgsMock: vi.fn<() => string[] | null>(() => [
    '--rcfile',
    'C:\\Users\\Test User\\AppData\\Roaming\\orca\\shell-wrappers\\abc\\shell-ready\\bash\\rcfile'
  ])
}))

vi.mock('../../local-pty/local-pty-shell-ready-wrapper-generation', () => ({
  ensureShellReadyWrappersAt: ensureWrappersMock
}))

vi.mock('../../local-pty/local-pty-shell-ready', () => ({
  getBashWrapperLaunchArgs: getBashWrapperArgsMock
}))

import { resolveWindowsShellLaunchArgs } from './shell-args'
import { getBashShellReadyRcfileContent } from '../../local-pty/local-pty-shell-ready-bash-rcfile'
import { getDaemonBashShellReadyRcfileContent } from '../../../daemon/shell-readiness/daemon-bash-shell-ready-rcfile'

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveWindowsShellLaunchArgs for Git Bash', () => {
  it('passes --rcfile directly instead of wrapping in -c exec "$BASH" so MSYS2 does not keep an extra bash.exe alive', () => {
    const resolved = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\repo',
      'C:\\Users\\Test User'
    )

    expect(resolved.shellArgs).toEqual([
      '--rcfile',
      'C:/Users/Test User/AppData/Roaming/orca/shell-wrappers/abc/shell-ready/bash/rcfile',
      '-i'
    ])
  })

  it('falls back to -c chcp + exec login command only when shell-ready wrapper args are unavailable', () => {
    getBashWrapperArgsMock.mockReturnValueOnce(null)

    const resolved = resolveWindowsShellLaunchArgs(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\repo',
      'C:\\Users\\Test User'
    )

    expect(resolved.shellArgs).toEqual([
      '-c',
      'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'
    ])
  })

  it('sets UTF-8 console code page inside both bash shell-ready rcfiles for native Git Bash', () => {
    const expectedLine =
      '[[ -n "${MSYSTEM:-}" && -z "${WSL_DISTRO_NAME:-}" ]] && chcp.com 65001 >/dev/null 2>&1'

    expect(getBashShellReadyRcfileContent()).toContain(expectedLine)
    expect(getDaemonBashShellReadyRcfileContent()).toContain(expectedLine)
  })
})
