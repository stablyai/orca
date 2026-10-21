import { afterEach, describe, expect, it, vi } from 'vitest'
import { headlessServeOzonePlatformSwitches } from '../../shared/headless-serve-ozone-platform'
import { reexecHeadlessServeOnX11IfNeeded } from './headless-serve-x11-reexec'

vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => 'wayland' } } }))

const EXEC_PATH = '/opt/Orca/orca-ide'

/**
 * Electron's pre-main `--ozone-platform-hint=auto` resolution, verified against Electron 43 on
 * Linux: `XDG_SESSION_TYPE=wayland` alone selects Wayland, and app.commandLine changes made
 * afterwards do not move it, so only argv decides.
 */
function resolveOzonePlatform(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const explicit = argv.find((arg) => arg.startsWith('--ozone-platform='))
  if (explicit) {
    return explicit.slice('--ozone-platform='.length)
  }
  const hint = env.ELECTRON_OZONE_PLATFORM_HINT ?? 'auto'
  const wayland =
    hint === 'wayland' ||
    (hint === 'auto' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)))
  return wayland ? 'wayland' : 'x11'
}

/** Boots a fake Electron and returns the platform Chromium ends up on, following any exec. */
function bootServe(argv: string[], env: NodeJS.ProcessEnv): { platform: string; execs: number } {
  let execs = 0
  let current = argv
  for (;;) {
    let next: string[] | null = null
    reexecHeadlessServeOnX11IfNeeded({
      isServeMode: current.includes('--serve'),
      readResolvedOzonePlatform: () => resolveOzonePlatform(current, env),
      argv: current,
      platform: 'linux',
      execPath: EXEC_PATH,
      env,
      execve: (_file, args) => {
        next = args
      }
    })
    if (!next || execs > 2) {
      return { platform: resolveOzonePlatform(current, env), execs }
    }
    execs += 1
    current = next
  }
}

const SERVE_ARGS = ['--serve', '--serve-port', '6768', '--serve-no-pairing']

const matrix = (['wayland', 'x11', undefined] as const).flatMap((sessionType) =>
  ([':0', undefined] as const).flatMap((display) =>
    (['wayland-0', undefined] as const).flatMap((waylandDisplay) =>
      (['direct --serve', 'CLI-spawned'] as const).map((launch) => ({
        sessionType,
        display,
        waylandDisplay,
        launch
      }))
    )
  )
)

describe('reexecHeadlessServeOnX11IfNeeded', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(matrix)(
    '$launch serve runs on X11 with XDG_SESSION_TYPE=$sessionType DISPLAY=$display WAYLAND_DISPLAY=$waylandDisplay',
    ({ sessionType, display, waylandDisplay, launch }) => {
      const env: NodeJS.ProcessEnv = {
        ...(sessionType ? { XDG_SESSION_TYPE: sessionType } : {}),
        ...(display ? { DISPLAY: display } : {}),
        ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
      }
      const argv =
        launch === 'CLI-spawned'
          ? [EXEC_PATH, ...SERVE_ARGS, ...headlessServeOzonePlatformSwitches('linux')]
          : [EXEC_PATH, ...SERVE_ARGS]
      const booted = bootServe(argv, env)

      expect(booted.platform).toBe('x11')
      // The CLI path pins on the spawn, so it never pays for an exec.
      expect(booted.execs).toBe(
        launch === 'direct --serve' && resolveOzonePlatform(argv, env) === 'wayland' ? 1 : 0
      )
    }
  )

  it('pins an inherited ELECTRON_OZONE_PLATFORM_HINT=wayland and an argv hint', () => {
    const booted = bootServe([EXEC_PATH, '--ozone-platform-hint=auto', ...SERVE_ARGS], {
      ELECTRON_OZONE_PLATFORM_HINT: 'wayland'
    })
    expect(booted).toEqual({ platform: 'x11', execs: 1 })
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

  it("reads Electron's resolved switch by default", () => {
    const execve = vi.fn()
    reexecHeadlessServeOnX11IfNeeded({
      isServeMode: true,
      argv: [EXEC_PATH, '--serve'],
      platform: 'linux',
      execPath: EXEC_PATH,
      execve
    })
    expect(execve).toHaveBeenCalledWith(
      EXEC_PATH,
      [EXEC_PATH, '--ozone-platform=x11', '--serve'],
      expect.any(Object)
    )
  })

  it('leaves an explicit --ozone-platform alone', () => {
    const booted = bootServe([EXEC_PATH, '--ozone-platform=wayland', ...SERVE_ARGS], {
      XDG_SESSION_TYPE: 'wayland'
    })
    expect(booted).toEqual({ platform: 'wayland', execs: 0 })
  })

  it.each([
    { name: 'desktop launches', isServeMode: true, platform: 'darwin' as const },
    { name: 'non-serve Linux launches', isServeMode: false, platform: 'linux' as const }
  ])('does nothing for $name', ({ isServeMode, platform }) => {
    const execve = vi.fn()
    reexecHeadlessServeOnX11IfNeeded({
      isServeMode,
      readResolvedOzonePlatform: () => 'wayland',
      argv: [EXEC_PATH],
      platform,
      execve
    })
    expect(execve).not.toHaveBeenCalled()
  })

  it('keeps serving in-process when the runtime cannot exec', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const args = {
      isServeMode: true,
      readResolvedOzonePlatform: () => 'wayland',
      argv: [EXEC_PATH, '--serve'],
      platform: 'linux' as const
    }
    expect(() => reexecHeadlessServeOnX11IfNeeded({ ...args, execve: null })).not.toThrow()
    reexecHeadlessServeOnX11IfNeeded({
      ...args,
      execve: () => {
        throw new Error('EACCES')
      }
    })
    expect(stderr).toHaveBeenCalledWith('[serve] Could not restart on X11: EACCES\n')
  })
})
