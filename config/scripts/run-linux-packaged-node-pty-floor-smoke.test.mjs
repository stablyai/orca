import { readFileSync } from 'node:fs'
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

  it('loads node-pty from packaged runtime resources', () => {
    const childSource = readFileSync(
      new URL('./linux-packaged-node-pty-floor-child.cjs', import.meta.url),
      'utf8'
    )

    expect(childSource).toContain("join(resourcesDirectory, 'node_modules', 'node-pty')")
    expect(childSource).not.toContain("join(resourcesDirectory, 'app.asar'")
  })
})
