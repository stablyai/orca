import { describe, expect, it } from 'vitest'
import {
  SCRCPY_DEVICE_JAR_PATH,
  SCRCPY_SERVER_VERSION,
  pushScrcpyServerArgs,
  scrcpyForwardArgs,
  scrcpyRemoveForwardArgs,
  startScrcpyServerArgs
} from './scrcpy-server-deploy'

describe('scrcpy deploy args', () => {
  it('builds the push, forward, and remove-forward commands', () => {
    expect(pushScrcpyServerArgs('emulator-5554', '/local/scrcpy-server')).toEqual([
      '-s',
      'emulator-5554',
      'push',
      '/local/scrcpy-server',
      SCRCPY_DEVICE_JAR_PATH
    ])
    expect(scrcpyForwardArgs('emulator-5554', 27183, 'abcd1234')).toEqual([
      '-s',
      'emulator-5554',
      'forward',
      'tcp:27183',
      'localabstract:scrcpy_abcd1234'
    ])
    expect(scrcpyRemoveForwardArgs('emulator-5554', 27183)).toEqual([
      '-s',
      'emulator-5554',
      'forward',
      '--remove',
      'tcp:27183'
    ])
  })

  it('starts the server with the pinned version and h264 options', () => {
    const args = startScrcpyServerArgs('emulator-5554', { scid: 'abcd1234', maxSize: 1024 })
    expect(args.slice(0, 8)).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      `CLASSPATH=${SCRCPY_DEVICE_JAR_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_SERVER_VERSION
    ])
    expect(args).toContain('scid=abcd1234')
    expect(args).toContain('video_codec=h264')
    expect(args).toContain('control=true')
    expect(args).toContain('max_size=1024')
  })
})
