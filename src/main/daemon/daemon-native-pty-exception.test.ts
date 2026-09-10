import { describe, expect, it } from 'vitest'
import { isNativePtyException } from './daemon-native-pty-exception'

describe('isNativePtyException', () => {
  it.each([
    Object.assign(new Error('write EAGAIN'), {
      code: 'EAGAIN',
      stack: 'Error: write EAGAIN\n    at node-pty/lib/windowsTerminal.js:1:1'
    }),
    Object.assign(new Error('read EIO'), {
      stack: 'Error: read EIO\n    at /app/node_modules/node-pty/lib/unixTerminal.js:1:1'
    }),
    new Error('Pty process exited'),
    new Error('Invalid pty handle'),
    new Error('ioctl(2) failed, EBADF'),
    Object.assign(new Error('native write failed'), {
      code: 'EPIPE',
      stack: 'Error: native write failed\n    at node-pty/lib/windowsTerminal.js:1:1'
    })
  ])('contains native PTY failures without killing the daemon', (error) => {
    expect(isNativePtyException(error)).toBe(true)
  })

  it.each([
    new Error('database invariant failed'),
    new Error('database write EAGAIN'),
    new Error('write EPIPE'),
    new Error('pty metadata invariant failed'),
    new Error('node-pty metadata invariant failed'),
    Object.assign(new Error('database write failed'), { code: 'EAGAIN' }),
    Object.assign(new Error('socket write failed'), { code: 'EPIPE' }),
    new TypeError('logic bug'),
    'EAGAIN'
  ])('does not suppress unrelated or malformed failures', (error) => {
    expect(isNativePtyException(error)).toBe(false)
  })
})
