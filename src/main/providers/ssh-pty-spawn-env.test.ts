import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'

const bridge = {
  binDir: '/home/me/.orca-relay/bin',
  relayDir: '/home/me/.orca-remote/relay-v1',
  nodePath: '/usr/bin/node',
  sockPath: '/home/me/.orca-remote/relay-v1/relay.sock'
}

describe('buildSshPtySpawnEnv browser routing', () => {
  it('routes $BROWSER opens to the desktop that owns the SSH session', () => {
    const env = buildSshPtySpawnEnv({ env: { PATH: '/usr/bin' }, remoteCliBridgeEnv: bridge })
    expect(env.BROWSER).toBe("'/home/me/.orca-relay/bin/orca' open-url --url %s")
  })

  it('never overrides a BROWSER the user set', () => {
    const env = buildSshPtySpawnEnv({
      env: { PATH: '/usr/bin', BROWSER: 'w3m' },
      remoteCliBridgeEnv: bridge
    })
    expect(env.BROWSER).toBe('w3m')
  })

  it('leaves BROWSER alone on Windows hosts and without the CLI bridge', () => {
    const windows = buildSshPtySpawnEnv({
      env: { Path: 'C:\\Windows' },
      remoteCliBridgeEnv: { ...bridge, binDir: 'C:/Users/me/.orca-relay/bin', pathDelimiter: ';' }
    })
    expect(windows.BROWSER).toBeUndefined()
    expect(buildSshPtySpawnEnv({ env: { PATH: '/usr/bin' } }).BROWSER).toBeUndefined()
  })

  it('respects an explicit removal of BROWSER', () => {
    const env = buildSshPtySpawnEnv({
      env: { PATH: '/usr/bin' },
      remoteCliBridgeEnv: bridge,
      envToDelete: ['BROWSER']
    })
    expect(env.BROWSER).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a bin dir with spaces and quotes as one word when a shell runs $BROWSER',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca browser '))
      const binDir = join(root, "it's bin")
      mkdirSync(binDir)
      const log = join(root, 'calls.log')
      writeFileSync(join(binDir, 'orca'), `#!/bin/sh\necho "$*" > '${log}'\n`, { mode: 0o755 })
      const env = buildSshPtySpawnEnv({
        env: { PATH: '/usr/bin' },
        remoteCliBridgeEnv: { ...bridge, binDir }
      })
      // Tools substitute %s and hand the command to a shell.
      const command = env.BROWSER.replace('%s', 'https://auth.example/login')
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      const calls = readFileSync(log, 'utf8').trim()
      rmSync(root, { recursive: true, force: true })
      expect(result.status).toBe(0)
      expect(calls).toBe('open-url --url https://auth.example/login')
    }
  )
})
