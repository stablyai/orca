import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const nodeExecPath = '/usr/local/bin/node'

describe('resolvePnpmCliInvocation', () => {
  it('runs a JS CLI through node so older pnpm.cjs still works', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '/Users/runner/setup-pnpm/node_modules/pnpm/bin/pnpm.cjs',
        nodeExecPath,
        platform: 'darwin'
      })
    ).toEqual({
      command: nodeExecPath,
      prefixArgs: ['/Users/runner/setup-pnpm/node_modules/pnpm/bin/pnpm.cjs'],
      shell: false
    })
  })

  it('executes pnpm 12 native binaries directly instead of through node', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '/Users/runner/setup-pnpm/pnpm',
        nodeExecPath,
        platform: 'darwin'
      })
    ).toEqual({
      command: '/Users/runner/setup-pnpm/pnpm',
      prefixArgs: [],
      shell: false
    })
  })

  it('does not wrap a Windows native pnpm.exe in node', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: 'C:\\hostedtoolcache\\pnpm.exe',
        nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32'
      })
    ).toEqual({
      command: 'C:\\hostedtoolcache\\pnpm.exe',
      prefixArgs: [],
      shell: false
    })
  })

  it('shells out for a Windows .cmd wrapper', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: 'C:\\Users\\runner\\pnpm.cmd',
        nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32'
      })
    ).toEqual({
      command: 'C:\\Users\\runner\\pnpm.cmd',
      prefixArgs: [],
      shell: true
    })
  })

  it('treats .js and .mjs CLIs the same as .cjs', () => {
    for (const npmExecPath of ['/opt/pnpm.js', '/opt/pnpm.mjs']) {
      expect(resolvePnpmCliInvocation({ npmExecPath, nodeExecPath, platform: 'linux' })).toEqual({
        command: nodeExecPath,
        prefixArgs: [npmExecPath],
        shell: false
      })
    }
  })

  it('falls back to PATH pnpm when npm_execpath is unset', () => {
    expect(
      resolvePnpmCliInvocation({ npmExecPath: undefined, nodeExecPath, platform: 'darwin' })
    ).toEqual({ command: 'pnpm', prefixArgs: [], shell: false })
    expect(resolvePnpmCliInvocation({ npmExecPath: '', nodeExecPath, platform: 'linux' })).toEqual({
      command: 'pnpm',
      prefixArgs: [],
      shell: false
    })
    expect(
      resolvePnpmCliInvocation({ npmExecPath: undefined, nodeExecPath, platform: 'win32' })
    ).toEqual({ command: 'pnpm.cmd', prefixArgs: [], shell: true })
  })
})

describe('pnpm 12 native-cli callers', () => {
  it('reinvokes pnpm through the helper rather than `node $npm_execpath`', () => {
    for (const file of [
      './build-native-for-platform.mjs',
      './run-ssh-docker-bulk-open-freeze-e2e.mjs'
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).toContain("from './pnpm-cli-invocation.mjs'")
      expect(source).not.toMatch(/process\.execPath,\s*\[\s*(?:pnpmEntry|npmExecPath)/)
    }
  })
})
