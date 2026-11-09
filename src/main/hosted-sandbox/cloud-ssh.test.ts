import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import {
  appRuntimePath,
  cloudSshHostAlias,
  proxyArg,
  renderSshHostBlock,
  upsertSshHostBlock,
  writeProxyLauncher
} from './cloud-ssh'

const block = (alias: string, wakeUrl = 'https://cp/v1/ssh-wake/sbx_1') =>
  renderSshHostBlock({
    alias,
    identityFile: '/u/My Data/cloud-ssh/id_ed25519',
    knownHostsFile: '/u/My Data/cloud-ssh/known_hosts',
    launcher: '/u/My Data/cloud-ssh/orca-cloud-ssh-proxy',
    wakeUrl,
    secretFile: '/u/My Data/cloud-ssh/sbx_1.secret',
    configFile: '/u/My Data/cloud-ssh/config',
    platform: 'darwin'
  })

describe('cloud ssh config', () => {
  it('derives an alias that is unique per sandbox', () => {
    const a = cloudSshHostAlias('Fix login bug!', 'sbx_0123456789abcdef01234567')
    const b = cloudSshHostAlias('Fix login bug!', 'sbx_fedcba9876543210fedcba98')
    expect(a).toBe('orca-cloud-fix-login-bug-01234567')
    expect(a).not.toBe(b)
    expect(cloudSshHostAlias(undefined, 'sbx_0123456789abcdef01234567')).toBe('orca-cloud-01234567')
  })

  it('quotes ProxyCommand args for sh with % escaped, and disables agent/X11 forwarding', () => {
    expect(proxyArg("/a b/it's 100%", 'darwin')).toBe("'/a b/it'\\''s 100%%'")
    expect(proxyArg('C:\\Users\\A B\\x.cmd', 'win32')).toBe('"C:\\Users\\A B\\x.cmd"')
    const text = block('orca-cloud-a')
    expect(text).toContain('IdentityFile "/u/My Data/cloud-ssh/id_ed25519"')
    expect(text).toContain(
      "ProxyCommand '/u/My Data/cloud-ssh/orca-cloud-ssh-proxy' 'https://cp/v1/ssh-wake/sbx_1'"
    )
    expect(text).toContain("'orca-cloud-a' 'vercel-sandbox'")
    expect(text).toContain('ForwardAgent no')
    expect(text).toContain('ForwardX11 no')
  })

  it('round-trips a ProxyCommand arg through sh after ssh %-expansion', () => {
    const value = "/tmp/x y/a'b$HOME`id`%"
    const shell = proxyArg(value, 'darwin').replace(/%%/g, '%')
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shell}`], { encoding: 'utf8' })).toBe(value)
  })

  it('replaces only the same host block', () => {
    let config = upsertSshHostBlock('', 'orca-cloud-a', block('orca-cloud-a'))
    config = upsertSshHostBlock(
      config,
      'orca-cloud-b',
      block('orca-cloud-b', 'https://cp/v1/ssh-wake/sbx_b')
    )
    config = upsertSshHostBlock(
      config,
      'orca-cloud-a',
      block('orca-cloud-a', 'https://cp/v1/ssh-wake/sbx_2')
    )
    expect(config.match(/^Host /gm)).toHaveLength(2)
    expect(config).toContain('sbx_2')
    expect(config).not.toContain("ssh-wake/sbx_1'")
    expect(config).toContain('Host orca-cloud-b')
  })

  it('writes a launcher that sets the runtime variable itself (POSIX and Windows) and prefers the AppImage path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-ssh-'))
    const posix = await writeProxyLauncher(dir, 'linux', "/opt/Orca's app/orca")
    expect(readFileSync(posix, 'utf8')).toContain(
      "ELECTRON_RUN_AS_NODE=1 exec '/opt/Orca'\\''s app/orca'"
    )
    const win = await writeProxyLauncher(dir, 'win32', 'C:\\Program Files\\Orca\\Orca.exe')
    expect(win.endsWith('.cmd')).toBe(true)
    expect(readFileSync(win, 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(appRuntimePath({ APPIMAGE: '/home/u/Orca.AppImage' }, '/tmp/.mount_x/orca')).toBe(
      '/home/u/Orca.AppImage'
    )
  })
})
