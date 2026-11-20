import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveImage, spawn } = vi.hoisted(() => ({ resolveImage: vi.fn(), spawn: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-profile' } }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn }))
vi.mock('../../updater/linux-package/appimage-runtime-identity', () => ({
  resolveAppImageRelaunchPath: resolveImage
}))

import { prepareAppImageRelaunch } from './appimage-relaunch'

const execPath = process.execPath

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  resolveImage.mockResolvedValue('/opt/Orca Nightly.AppImage')
})

afterEach(() => {
  process.execPath = execPath
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function readyLauncher(stdin: Writable = new PassThrough()) {
  const stdout = new PassThrough()
  spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout, stdin, unref: vi.fn() })
    queueMicrotask(() => stdout.write('ready\n'))
    return child
  })
  return stdin
}

describe('AppImage launcher', () => {
  it('keeps extract-and-run and desktop arguments while removing only the AppRun suffixes', async () => {
    const mount = '/tmp/appimage_extracted_abc'
    process.execPath = `${mount}/orca-ide`
    vi.stubEnv('APPDIR', mount)
    vi.stubEnv('APPIMAGE', '/opt/Orca Nightly.AppImage')
    vi.stubEnv('APPIMAGE_EXTRACT_AND_RUN', undefined)
    vi.stubEnv('LD_LIBRARY_PATH', `${mount}/usr/lib:/usr/local/lib`)
    vi.stubEnv(
      'XDG_DATA_DIRS',
      `${mount}/usr/share/:/custom/share:/usr/share/:/next:/usr/share/gnome:/usr/local/share/:/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`
    )
    const input = readyLauncher()
    const command = vi.fn()
    input.on('data', (value) => command(String(value)))

    const restart = await prepareAppImageRelaunch(
      ['--', "file 'name' $d", ''],
      new AbortController().signal
    )
    expect(command).not.toHaveBeenCalled()
    await restart.commit()

    const { args, env } = spawn.mock.calls[0][0]
    expect(args.slice(6)).toEqual(['/opt/Orca Nightly.AppImage', '--', "file 'name' $d", ''])
    expect(env.XDG_DATA_DIRS).toBe('/custom/share:/usr/share/:/next')
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/lib')
    expect(env.APPIMAGE_EXTRACT_AND_RUN).toBe('1')
    expect(env.APPDIR).toBeUndefined()
    expect(command).toHaveBeenCalledWith('restart\n')
  })

  it('reports missing artifacts and launcher spawn errors before authorizing restart', async () => {
    const signal = new AbortController().signal
    resolveImage.mockResolvedValueOnce(null)
    await expect(prepareAppImageRelaunch([], signal)).rejects.toThrow(
      'original AppImage is missing'
    )
    expect(spawn).not.toHaveBeenCalled()

    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        unref: vi.fn()
      })
      queueMicrotask(() => child.emit('error', new Error('spawn bash ENOENT')))
      return child
    })
    await expect(prepareAppImageRelaunch([], signal)).rejects.toThrow('spawn bash ENOENT')
  })

  it('discards a prepared launcher if the artifact disappears before commit', async () => {
    const stdin = readyLauncher()
    const command = vi.fn()
    stdin.on('data', command)
    const restart = await prepareAppImageRelaunch([], new AbortController().signal)
    resolveImage.mockResolvedValueOnce(null)
    await expect(restart.commit()).rejects.toThrow('original AppImage moved')
    expect(command).not.toHaveBeenCalled()
  })

  it('reports a broken launcher stdin without an unhandled stream error', async () => {
    readyLauncher(
      new Writable({
        write(_data, _encoding, done) {
          done(new Error('broken launcher stdin'))
        }
      })
    )
    const restart = await prepareAppImageRelaunch([], new AbortController().signal)
    await expect(restart.commit()).rejects.toThrow('broken launcher stdin')
  })
})
