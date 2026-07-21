import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DictationOutputControlService,
  type DictationOutputControlExecFile
} from './dictation-output-control'

const MUSIC_PROBE_AND_PAUSE_SCRIPT =
  "(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.Music'); if (runningApps.count === 0) return ''; const a = Application('com.apple.Music'); if (String(a.playerState()) !== 'playing') return ''; a.pause(); return 'paused'; })()"
const SPOTIFY_PROBE_AND_PAUSE_SCRIPT =
  "(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.spotify.client'); if (runningApps.count === 0) return ''; const a = Application('com.spotify.client'); if (String(a.playerState()) !== 'playing') return ''; a.pause(); return 'paused'; })()"
const MUSIC_PLAY_SCRIPT =
  "(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.Music'); if (runningApps.count === 0) return ''; const a = Application('com.apple.Music'); if (String(a.playerState()) === 'playing') return ''; a.play(); return 'played'; })()"
const SPOTIFY_PLAY_SCRIPT =
  "(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.spotify.client'); if (runningApps.count === 0) return ''; const a = Application('com.spotify.client'); if (String(a.playerState()) === 'playing') return ''; a.play(); return 'played'; })()"
const DISALLOWED_MEDIA_CONTROL_PATTERNS = [
  'NX_KEYTYPE_PLAY',
  'CGEventPost',
  'NSEvent',
  'MediaRemote',
  'System Events'
]

const jxaArgs = (script: string): string[] => ['-l', 'JavaScript', '-e', script]

const scriptCalls = (execFile: DictationOutputControlExecFile): string[] =>
  vi.mocked(execFile).mock.calls.map(([, args]) => args.at(-1) ?? '')

const expectNoGenericMediaControlScripts = (calls: string[]): void => {
  for (const script of calls) {
    for (const pattern of DISALLOWED_MEDIA_CONTROL_PATTERNS) {
      expect(script).not.toContain(pattern)
    }
  }
}

function createExecFile(
  stdoutByScript: Record<string, string> = {}
): DictationOutputControlExecFile {
  return vi.fn((_file, args, _options, callback) => {
    const script = args.at(-1) ?? ''
    callback(null, stdoutByScript[script] ?? '', '')
    return { kill: vi.fn(), once: vi.fn() }
  }) as unknown as DictationOutputControlExecFile
}

describe('DictationOutputControlService', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('snapshots macOS volume and mute before muting output', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '67\n',
      'output muted of (get volume settings)': 'false\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/osascript',
      ['-e', 'output volume of (get volume settings)'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/osascript',
      ['-e', 'output muted of (get volume settings)'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenLastCalledWith(
      '/usr/bin/osascript',
      ['-e', 'set volume with output muted'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
  })

  it('ducks macOS output to the requested volume', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '80\n',
      'output muted of (get volume settings)': 'false\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 15
    })

    expect(execFile).toHaveBeenLastCalledWith(
      '/usr/bin/osascript',
      ['-e', 'set volume output volume 15'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
  })

  it('restores mute and volume exactly once per session', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '70\n',
      'output muted of (get volume settings)': 'true\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 10
    })
    await service.restoreForSession('owner:session')
    await service.restoreForSession('owner:session')

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', 'set volume output volume 70'],
      expect.any(Object),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', 'set volume with output muted'],
      expect.any(Object),
      expect.any(Function)
    )
    const restoreCalls = vi
      .mocked(execFile)
      .mock.calls.filter(([, args]) => String(args[1]).startsWith('set volume'))
    expect(restoreCalls).toHaveLength(3)
  })

  it('restores overlapping sessions in reverse apply order', async () => {
    const volumeResponses = ['80\n', '20\n']
    const execFile = vi.fn((_file, args, _options, callback) => {
      const script = args[1] ?? ''
      callback(
        null,
        script === 'output volume of (get volume settings)'
          ? (volumeResponses.shift() ?? '')
          : script === 'output muted of (get volume settings)'
            ? 'false\n'
            : '',
        ''
      )
      return { kill: vi.fn(), once: vi.fn() }
    }) as unknown as DictationOutputControlExecFile
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:first', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 20
    })
    await service.applyForSession('owner:second', {
      pauseMedia: false,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })

    await service.restoreAll()

    const restoreScripts = vi
      .mocked(execFile)
      .mock.calls.map(([, args]) => args[1])
      .filter((script) => String(script).startsWith('set volume'))
      .slice(2)
    expect(restoreScripts).toEqual([
      'set volume output volume 20',
      'set volume without output muted',
      'set volume output volume 80',
      'set volume without output muted'
    ])
  })

  it('does not overwrite the original snapshot on duplicate apply', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '70\n',
      'output muted of (get volume settings)': 'false\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 10
    })
    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })

    expect(execFile).toHaveBeenCalledTimes(3)
  })

  it('pauses playing Music and Spotify and resumes only those apps', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '70\n',
      'output muted of (get volume settings)': 'false\n',
      [MUSIC_PROBE_AND_PAUSE_SCRIPT]: 'paused\n',
      [SPOTIFY_PROBE_AND_PAUSE_SCRIPT]: 'paused\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: true,
      volumeMode: 'unchanged',
      duckedVolumePercent: 20
    })
    await service.restoreForSession('owner:session')

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      jxaArgs(MUSIC_PROBE_AND_PAUSE_SCRIPT),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      jxaArgs(SPOTIFY_PROBE_AND_PAUSE_SCRIPT),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
    expectNoGenericMediaControlScripts(scriptCalls(execFile))
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      jxaArgs(MUSIC_PLAY_SCRIPT),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      jxaArgs(SPOTIFY_PLAY_SCRIPT),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    )
  })

  it('skips app resumes when media was not playing', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '70\n',
      'output muted of (get volume settings)': 'false\n',
      [MUSIC_PROBE_AND_PAUSE_SCRIPT]: '',
      [SPOTIFY_PROBE_AND_PAUSE_SCRIPT]: ''
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: true,
      volumeMode: 'unchanged',
      duckedVolumePercent: 20
    })
    await service.restoreForSession('owner:session')

    const calls = scriptCalls(execFile)
    expect(calls).toContain(MUSIC_PROBE_AND_PAUSE_SCRIPT)
    expect(calls).toContain(SPOTIFY_PROBE_AND_PAUSE_SCRIPT)
    expectNoGenericMediaControlScripts(calls)
    expect(calls).not.toContain(MUSIC_PLAY_SCRIPT)
    expect(calls).not.toContain(SPOTIFY_PLAY_SCRIPT)
  })

  it('does not run JXA media commands when pause media is disabled', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '70\n',
      'output muted of (get volume settings)': 'false\n'
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'unchanged',
      duckedVolumePercent: 20
    })

    expect(vi.mocked(execFile).mock.calls.filter(([, args]) => args[0] === '-l')).toHaveLength(0)
  })

  it('returns no-op capabilities and does not call execFile on unsupported platforms', async () => {
    const execFile = createExecFile()
    const service = new DictationOutputControlService({ platform: 'linux', execFile })

    await expect(service.getCapabilities()).resolves.toEqual({
      canMuteOutput: false,
      canDuckOutput: false,
      canPauseMedia: false
    })
    await service.applyForSession('owner:session', {
      pauseMedia: true,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })

    expect(execFile).not.toHaveBeenCalled()
  })

  it('hides macOS capabilities when the volume probe fails', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': ''
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await expect(service.getCapabilities()).resolves.toEqual({
      canMuteOutput: false,
      canDuckOutput: false,
      canPauseMedia: false
    })
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('skips output changes when the mute probe fails', async () => {
    const execFile = createExecFile({
      'output volume of (get volume settings)': '67\n',
      'output muted of (get volume settings)': ''
    })
    const service = new DictationOutputControlService({ platform: 'darwin', execFile })

    await service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })

    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('treats timed-out commands as best-effort failures', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn(), once: vi.fn() }
    const execFile = vi.fn(() => child) as unknown as DictationOutputControlExecFile
    const service = new DictationOutputControlService({
      platform: 'darwin',
      execFile,
      commandTimeoutMs: 25
    })

    const result = service.applyForSession('owner:session', {
      pauseMedia: false,
      volumeMode: 'mute',
      duckedVolumePercent: 20
    })
    await vi.advanceTimersByTimeAsync(25)

    await expect(result).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalled()
  })
})
