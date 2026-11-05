import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { packagedNodePtyFloorDockerArgs } from './run-linux-packaged-node-pty-floor-smoke.mjs'

describe('packaged node-pty Linux floor smoke', () => {
  it('mounts the exact package read-only in an Ubuntu 20.04 container', () => {
    const args = packagedNodePtyFloorDockerArgs({
      workspaceDirectory: '/repo',
      appDirectory: 'dist/linux-arm64-unpacked'
    })

    expect(args).toContain('type=bind,src=/repo,dst=/workspace,readonly')
    expect(args).toContain('ubuntu:20.04')
    expect(args.at(-1)).toContain('/workspace/dist/linux-arm64-unpacked/orca-ide')
    expect(args.at(-1)).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('rejects an app directory outside the workspace', () => {
    expect(() =>
      packagedNodePtyFloorDockerArgs({
        workspaceDirectory: '/repo',
        appDirectory: '../outside'
      })
    ).toThrow('linux-packaged-node-pty-floor-app-directory-invalid')
  })

  it.each([
    ['valid output', 0, 'orca-node-pty-floor-ok', 0],
    ['nonzero exit', 3, 'orca-node-pty-floor-ok', 1],
    ['wrong output', 0, 'unexpected', 1]
  ])('validates packaged node-pty %s', (_name, exitCode, output, expectedCode) => {
    const resources = mkdtempSync(join(tmpdir(), 'packaged-node-pty-floor-'))
    const moduleDirectory = join(resources, 'node_modules', 'node-pty')
    mkdirSync(moduleDirectory, { recursive: true })
    writeFileSync(
      join(moduleDirectory, 'index.js'),
      `module.exports = { spawn() { return {
        onData(callback) { callback(${JSON.stringify(output)}) },
        onExit(callback) { queueMicrotask(() => callback({ exitCode: ${exitCode} })) },
        kill() {}
      } } }`
    )
    try {
      const result = runProcessSync({
        program: process.execPath,
        args: [
          fileURLToPath(new URL('./linux-packaged-node-pty-floor-child.cjs', import.meta.url)),
          resources
        ]
      })
      expect(result.code, result.stderr).toBe(expectedCode)
      expect(result.stdout).toBe(expectedCode === 0 ? 'orca-node-pty-floor-ok\n' : '')
      if (expectedCode !== 0) {
        expect(result.stderr).toContain('packaged node-pty floor smoke failed:')
      }
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })
})
