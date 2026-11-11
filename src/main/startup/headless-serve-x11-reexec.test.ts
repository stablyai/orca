import { afterEach, describe, expect, it, vi } from 'vitest'
import { reexecHeadlessServeOnX11IfNeeded } from './headless-serve-x11-reexec'

vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => 'wayland' } } }))

const EXEC_PATH = '/opt/Orca/orca-ide'

describe('reexecHeadlessServeOnX11IfNeeded', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the pid, env and argv order, with the switch ahead of a `--` terminator', () => {
    const execve = vi.fn()
    const env = { XDG_SESSION_TYPE: 'wayland', HOME: '/home/orca' }
    reexecHeadlessServeOnX11IfNeeded({
      isServeMode: true,
      readResolvedOzonePlatform: () => 'wayland',
      argv: [EXEC_PATH, '--serve', '--', '--ozone-platform=wayland'],
      platform: 'linux',
      execPath: EXEC_PATH,
      env,
      execve
    })
    expect(execve).toHaveBeenCalledWith(
      EXEC_PATH,
      [EXEC_PATH, '--ozone-platform=x11', '--serve', '--', '--ozone-platform=wayland'],
      env
    )
  })
})
