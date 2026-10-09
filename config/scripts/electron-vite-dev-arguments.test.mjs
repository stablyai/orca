import { describe, expect, it } from 'vitest'
import { createElectronViteDevArguments } from './electron-vite-dev-arguments.mjs'

describe('Electron development arguments', () => {
  it('watches main and external workspace source changes by default', () => {
    expect(createElectronViteDevArguments(['--remote-debugging-port=9222'])).toEqual([
      'dev',
      '--watch',
      '--remote-debugging-port=9222'
    ])
  })

  it('preserves forwarded Electron arguments without interpreting them as Vite flags', () => {
    expect(createElectronViteDevArguments(['--', '--version'])).toEqual([
      'dev',
      '--watch',
      '--',
      '--version'
    ])
  })

  it.each(['--watch', '-w', '--no-watch', '--watch=false', '--help', '-h', '--version'])(
    'respects explicit %s',
    (flag) => {
      expect(createElectronViteDevArguments([flag])).toEqual(['dev', flag])
    }
  )
})
