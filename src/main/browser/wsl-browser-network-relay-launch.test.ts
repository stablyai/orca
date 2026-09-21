import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWslBrowserNetworkGuestInstallScript,
  buildWslBrowserNetworkGuestLaunchScript
} from './wsl-browser-network-relay-launch'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('WSL browser network relay launch', () => {
  it('builds a shell-valid exact-version launcher with a Node 18 floor', () => {
    const script = buildWslBrowserNetworkGuestLaunchScript('0.1.0+abc123')

    execFileSync('sh', ['-n'], { input: script })
    expect(script).toContain('.orca-wsl/browser-network/0.1.0+abc123')
    expect(script).toContain('Number(process.versions.node.split(".")[0])>=18')
    expect(script).toContain('wsl-browser-network-relay.js')
    expect(() => buildWslBrowserNetworkGuestLaunchScript("bad'version")).toThrow(
      'browser_tunnel_execution_host_unavailable'
    )
  })

  it('installs exact bundle bytes and writes the version marker last', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-wsl-browser-network-'))
    roots.push(root)
    const bundle = Buffer.from([0, 1, 2, 3, 255])
    const version = '0.1.0+bundle'
    const script = buildWslBrowserNetworkGuestInstallScript(bundle, version)

    execFileSync('sh', ['-s'], { input: script, env: { ...process.env, HOME: root } })

    const installDir = join(root, '.orca-wsl', 'browser-network', version)
    expect(readFileSync(join(installDir, 'wsl-browser-network-relay.js'))).toEqual(bundle)
    expect(readFileSync(join(installDir, '.browser-network-version'), 'utf8')).toBe(version)
    expect(readFileSync(join(installDir, 'launch.sh'), 'utf8')).toContain(version)
  })
})
