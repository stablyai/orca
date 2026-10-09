import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveWslHookRelayBundle } from './wsl-hook-relay-launch'
import { resolveWslBrowserNetworkRelayBundle } from '../browser/wsl-browser-network-relay-launch'
import {
  WSL_HOOK_RELAY_BUNDLE_NAME,
  WSL_HOOK_RELAY_VERSION_FILE
} from '../../shared/wsl-hook-relay-contract'
import {
  WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME,
  WSL_BROWSER_NETWORK_RELAY_VERSION_FILE
} from '../../shared/wsl-browser-network-relay-contract'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('gives both WSL relays a new install directory even when bundle bytes are unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-runtime-policy-'))
  roots.push(root)
  const dir = join(root, 'wsl')
  mkdirSync(dir)
  vi.stubEnv('ORCA_RELAY_PATH', root)
  const version = '0.1.0+unchanged'
  for (const [bundleName, versionFile] of [
    [WSL_HOOK_RELAY_BUNDLE_NAME, WSL_HOOK_RELAY_VERSION_FILE],
    [WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME, WSL_BROWSER_NETWORK_RELAY_VERSION_FILE]
  ]) {
    writeFileSync(join(dir, bundleName), 'unchanged bundle')
    writeFileSync(join(dir, versionFile), version)
  }

  expect(resolveWslHookRelayBundle()).toEqual({
    jsPath: join(dir, WSL_HOOK_RELAY_BUNDLE_NAME),
    version: `${version}-node24`
  })
  expect(resolveWslBrowserNetworkRelayBundle()).toEqual({
    jsPath: join(dir, WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME),
    version: `${version}-node24`
  })
})
