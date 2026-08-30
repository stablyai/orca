import { describe, expect, it } from 'vitest'
import { resolvePnpmInvocation } from './build-native-for-platform.mjs'

describe('resolvePnpmInvocation', () => {
  it('runs a JS npm_execpath through the current node binary', () => {
    expect(
      resolvePnpmInvocation('build:computer-macos', '/somewhere/pnpm/bin/pnpm.cjs', 'darwin')
    ).toEqual({
      command: process.execPath,
      args: ['/somewhere/pnpm/bin/pnpm.cjs', 'run', 'build:computer-macos']
    })
    expect(
      resolvePnpmInvocation('build:x', '/somewhere/npm/bin/npm-cli.js', 'darwin').command
    ).toBe(process.execPath)
  })

  it('falls back to pnpm on PATH when npm_execpath is a platform binary', () => {
    // pnpm's standalone build sets npm_execpath to the executable it ran, which
    // node cannot parse as a module.
    expect(
      resolvePnpmInvocation(
        'build:computer-macos',
        '/Users/me/Library/pnpm/.tools/@pnpm+macos-arm64/10.24.0/node_modules/@pnpm/macos-arm64/pnpm',
        'darwin'
      )
    ).toEqual({ command: 'pnpm', args: ['run', 'build:computer-macos'] })
  })

  it('falls back to pnpm on PATH when npm_execpath is unset', () => {
    expect(resolvePnpmInvocation('build:x', undefined, 'darwin')).toEqual({
      command: 'pnpm',
      args: ['run', 'build:x']
    })
    expect(resolvePnpmInvocation('build:x', '', 'darwin')).toEqual({
      command: 'pnpm',
      args: ['run', 'build:x']
    })
  })

  it('uses pnpm.cmd on windows when falling back', () => {
    expect(resolvePnpmInvocation('build:x', undefined, 'win32')).toEqual({
      command: 'pnpm.cmd',
      args: ['run', 'build:x']
    })
  })
})
