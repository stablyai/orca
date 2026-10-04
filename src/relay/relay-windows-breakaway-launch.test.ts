import { describe, expect, it, vi } from 'vitest'
import { quoteWindowsArgument } from '../shared/child-process/windows-command-line'
import {
  RELAY_WINDOWS_BREAKAWAY_EXIT_CODES,
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../shared/relay-windows-breakaway-launch'
import {
  launchRelayOutsideJob,
  loadSpawnOutsideJob,
  parseRelayWindowsBreakawayLaunch,
  type SpawnOutsideJob
} from './relay-windows-breakaway-launch'

const argv = [
  'C:\\rt\\node.exe',
  'C:\\Users\\me user\\.orca-remote\\relay-1\\relay.js',
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  '--stdout-file',
  'C:/Users/me user/relay.log',
  '--stderr-file',
  'C:/Users/me user/relay.err.log',
  '--relay-args',
  '--detached',
  '--sock-path',
  '\\\\.\\pipe\\orca-relay-1',
  '--log-file',
  'C:/Users/me user/relay.log'
]
const runtime = { execPath: argv[0], relayScript: argv[1], cwd: 'C:\\Users\\me user' }

function requestFrom(args: readonly string[]) {
  const request = parseRelayWindowsBreakawayLaunch(args)
  if (!request) {
    throw new Error('expected a launch request')
  }
  return request
}

describe('relay Windows breakaway launcher', () => {
  it('is not requested by an ordinary relay launch', () => {
    expect(parseRelayWindowsBreakawayLaunch(['node', 'relay.js', '--detached'])).toBeNull()
  })

  it('takes its own flags before -- and hands the rest to the relay', () => {
    expect(parseRelayWindowsBreakawayLaunch(argv)).toEqual({
      stdoutPath: 'C:/Users/me user/relay.log',
      stderrPath: 'C:/Users/me user/relay.err.log',
      relayArgs: argv.slice(8)
    })
  })

  it('refuses a request without its output files', () => {
    expect(() =>
      parseRelayWindowsBreakawayLaunch(['node', 'relay.js', RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG])
    ).toThrow('--stdout-file')
  })

  it('starts the same node and relay script with the relay args, quoted for CommandLineToArgvW', () => {
    const spawn = vi.fn<SpawnOutsideJob>(() => ({ ok: true, pid: 4242, inJob: false }))

    const outcome = launchRelayOutsideJob(requestFrom(argv), spawn, runtime)

    expect(outcome).toEqual({
      report: { method: 'breakaway', pid: 4242, inJob: false },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.launched
    })
    expect(spawn).toHaveBeenCalledWith(
      runtime.execPath,
      [runtime.execPath, runtime.relayScript, ...argv.slice(8)].map(quoteWindowsArgument).join(' '),
      runtime.cwd,
      'C:/Users/me user/relay.log',
      'C:/Users/me user/relay.err.log'
    )
  })

  it('reports a job that refuses breakaway as unavailable so the script can try WMI', () => {
    const spawn: SpawnOutsideJob = () => ({
      ok: false,
      reason: 'breakaway-denied',
      step: 'create-process',
      code: 5
    })

    expect(launchRelayOutsideJob(requestFrom(argv), spawn, runtime)).toEqual({
      report: {
        method: 'unavailable',
        reason: 'breakaway-denied',
        step: 'create-process',
        code: 5
      },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
    })
  })

  it('reports any other CreateProcess failure as failed, without a WMI retry', () => {
    const spawn: SpawnOutsideJob = () => ({
      ok: false,
      reason: 'failed',
      step: 'open-stdout',
      code: 32
    })

    expect(launchRelayOutsideJob(requestFrom(argv), spawn, runtime)).toEqual({
      report: { method: 'failed', reason: 'failed', step: 'open-stdout', code: 32 },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.failed
    })
  })

  it('reports a missing launcher as unavailable', () => {
    expect(launchRelayOutsideJob(requestFrom(argv), 'addon-missing', runtime)).toEqual({
      report: { method: 'unavailable', reason: 'addon-missing' },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
    })
  })

  it('names an absent addon and one that predates the launcher', () => {
    expect(
      loadSpawnOutsideJob(() => {
        throw new Error('Cannot find module')
      }, 'win32')
    ).toBe('addon-missing')
    expect(loadSpawnOutsideJob(() => ({ getProcessList: () => {} }), 'win32')).toBe(
      'addon-predates-launcher'
    )
  })

  it('reads an unrecognised addon result as a failure', () => {
    const spawn = loadSpawnOutsideJob(() => ({ spawnOutsideJob: () => ({ ok: true }) }), 'win32')
    if (typeof spawn !== 'function') {
      throw new Error(`expected a launcher, got ${spawn}`)
    }
    expect(spawn('a', 'b', 'c', 'd', 'e')).toEqual({
      ok: false,
      reason: 'unrecognized-result',
      step: 'create-process',
      code: 0
    })
  })

  it('never binds the addon off Windows', () => {
    expect(loadSpawnOutsideJob(() => ({ spawnOutsideJob: () => ({}) }), 'linux')).toBe(
      'not-windows'
    )
  })
})
