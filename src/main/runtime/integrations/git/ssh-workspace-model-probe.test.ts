import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import type { RemoteCommandChannel } from '../../../managed-server/install/remote-install-transport'
import type { SshExecOptions } from '../../../ssh/connection/ssh-exec-options'
import { discoverModelsOverSsh, runSshModelProbe } from './ssh-workspace-model-probe'

const OUTPUT_LIMIT = 1024 * 1024

function openChannel(): RemoteCommandChannel {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  let closed = false
  return Object.assign(stdout, {
    stderr,
    stdin,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      stdout.emit('close', 1)
    }
  })
}

function requireChannel(channel: RemoteCommandChannel | null): RemoteCommandChannel {
  if (!channel) {
    throw new Error('missing ssh channel')
  }
  return channel
}

function connectedExec(
  platform: 'win32' | 'linux',
  exec: (command: string, options?: SshExecOptions) => Promise<RemoteCommandChannel>
) {
  return {
    remotePlatform: () => platform,
    connection: () => ({
      getState: () => ({ status: 'connected' as const }),
      exec,
      usesSystemSshTransport: () => false
    })
  }
}

describe('runSshModelProbe', () => {
  it('does not wrap a Windows command in /bin/sh', async () => {
    let channel: RemoteCommandChannel | null = null
    const exec = vi.fn((_command: string, _options?: SshExecOptions) => {
      const opened = openChannel()
      channel = opened
      return Promise.resolve(opened)
    })
    const pending = runSshModelProbe(
      'box',
      'powershell.exe -EncodedCommand QQ==',
      null,
      connectedExec('win32', exec)
    )
    await Promise.resolve()
    requireChannel(channel).emit('close', 0)
    await pending
    expect(exec.mock.calls[0]?.[1]?.wrapCommand).toBe(false)
  })

  it('keeps only a bounded tail and reports a stderr stream error', async () => {
    let channel: RemoteCommandChannel | null = null
    const exec = vi.fn((_command: string, _options?: SshExecOptions) => {
      const opened = openChannel()
      channel = opened
      return Promise.resolve(opened)
    })
    const bounded = runSshModelProbe('box', 'claude', null, connectedExec('linux', exec))
    await Promise.resolve()
    const opened = requireChannel(channel)
    opened.emit('data', Buffer.from(`head-${'x'.repeat(OUTPUT_LIMIT)}-TAIL`))
    opened.emit('close', 0)
    const listed = await bounded
    expect(
      'stdout' in listed && listed.stdout.endsWith('TAIL') && listed.stdout.length <= OUTPUT_LIMIT
    ).toBe(true)

    const stderrExec = vi.fn((_command: string, _options?: SshExecOptions) => {
      const opened = openChannel()
      channel = opened
      return Promise.resolve(opened)
    })
    const failed = runSshModelProbe('box', 'claude', null, connectedExec('linux', stderrExec))
    await Promise.resolve()
    const failedChannel = requireChannel(channel)
    expect(() => failedChannel.stderr.emit('error', new Error('stderr broke'))).not.toThrow()
    const failure = await failed
    expect(failure).toEqual({ error: 'SSH model discovery transport failed.' })
    expect(JSON.stringify(failure)).not.toContain('stderr broke')
  })

  it('does not return command-line secrets from a timeout or exec failure', async () => {
    const secret = 'super-secret-token'
    const command = `ANTHROPIC_API_KEY=${secret} claude`
    const timeout = Object.assign(new Error(`Command "${command}" timed out after 120s`), {
      code: 'SSH_EXEC_TIMEOUT'
    })
    const timedOut = await runSshModelProbe(
      'box',
      command,
      null,
      connectedExec('linux', () => Promise.reject(timeout))
    )
    expect(timedOut).toEqual({
      error: 'SSH target "box" timed out while listing models.'
    })
    expect(JSON.stringify(timedOut)).not.toContain(secret)

    const rejected = await runSshModelProbe(
      'box',
      command,
      null,
      connectedExec('linux', () => Promise.reject(new Error(`exec failed: ${command}`)))
    )
    expect(rejected).toEqual({ error: 'SSH model discovery transport failed.' })
    expect(JSON.stringify(rejected)).not.toContain(secret)
  })

  it('does not leak a secret assignment when the SSH channel exits 1', async () => {
    const secret = 'super-secret-token'
    let channel: RemoteCommandChannel | null = null
    const exec = vi.fn((_command: string, _options?: SshExecOptions) => {
      const opened = openChannel()
      channel = opened
      return Promise.resolve(opened)
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = discoverModelsOverSsh({
      agentId: 'claude',
      cwd: '/srv/app',
      connectionId: 'box',
      windows: false,
      runRemoteProbe: (connectionId, command, stdin) =>
        runSshModelProbe(connectionId, command, stdin, connectedExec('linux', exec))
    })
    await Promise.resolve()
    await Promise.resolve()
    const opened = requireChannel(channel)
    opened.stderr.emit('data', Buffer.from(`API_KEY=${secret}\nKEY=${secret}\n`))
    opened.emit('close', 1)
    const result = await pending
    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret)
    errorSpy.mockRestore()
  })

  it('redacts a bare secret and a multi-word header from exit, timeout, and transport failures', async () => {
    const bare = 'synthetic-secret-value'
    const header = 'Authorization: Bearer DEMO_ONLY_HEADER'
    const leaks = (value: string): boolean =>
      value.includes(bare) || value.includes(header) || value.includes('DEMO_ONLY_HEADER')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { ANTHROPIC_API_KEY: bare, ANTHROPIC_CUSTOM_HEADERS: header }
    try {
      let channel: RemoteCommandChannel | null = null
      const exec = vi.fn((_command: string, _options?: SshExecOptions) => {
        const opened = openChannel()
        channel = opened
        return Promise.resolve(opened)
      })
      const pending = discoverModelsOverSsh({
        agentId: 'claude',
        cwd: '/srv/app',
        connectionId: 'box',
        windows: false,
        env,
        runRemoteProbe: (connectionId, command, stdin) =>
          runSshModelProbe(connectionId, command, stdin, connectedExec('linux', exec))
      })
      await Promise.resolve()
      await Promise.resolve()
      const opened = requireChannel(channel)
      opened.emit('data', Buffer.from(`stdout ${bare}\n`))
      opened.stderr.emit('data', Buffer.from(`ANTHROPIC_CUSTOM_HEADERS=${header}\n`))
      opened.emit('close', 1)
      const failed = await pending
      expect(leaks(JSON.stringify(failed))).toBe(false)
      expect(leaks(JSON.stringify(errorSpy.mock.calls))).toBe(false)

      const timeout = Object.assign(new Error(`timed out ${bare} ${header}`), {
        code: 'SSH_EXEC_TIMEOUT'
      })
      const timedOut = await discoverModelsOverSsh({
        agentId: 'claude',
        cwd: '/srv/app',
        connectionId: 'box',
        windows: false,
        env,
        runRemoteProbe: (connectionId, command, stdin) =>
          runSshModelProbe(
            connectionId,
            command,
            stdin,
            connectedExec('linux', () => Promise.reject(timeout))
          )
      })
      expect(leaks(JSON.stringify(timedOut))).toBe(false)

      const rejected = await discoverModelsOverSsh({
        agentId: 'claude',
        cwd: '/srv/app',
        connectionId: 'box',
        windows: false,
        env,
        runRemoteProbe: (connectionId, command, stdin) =>
          runSshModelProbe(
            connectionId,
            command,
            stdin,
            connectedExec('linux', () =>
              Promise.reject(new Error(`transport rejected ${bare} ${header}`))
            )
          )
      })
      expect(leaks(JSON.stringify(rejected))).toBe(false)
      expect(leaks(JSON.stringify(errorSpy.mock.calls))).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops a bare override echoed by a POSIX or PowerShell transport rejection', async () => {
    const secret = 'synthetic-orca-gateway-value'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const windows of [false, true]) {
        const rejected = await discoverModelsOverSsh({
          agentId: 'claude',
          cwd: windows ? 'C:\\srv\\app' : '/srv/app',
          connectionId: 'box',
          windows,
          env: { ORCA_GATEWAY_VALUE: secret },
          runRemoteProbe: (connectionId, command, stdin) =>
            runSshModelProbe(
              connectionId,
              command,
              stdin,
              connectedExec(windows ? 'win32' : 'linux', () => Promise.reject(new Error(secret)))
            )
        })
        const logged = JSON.stringify(errorSpy.mock.calls)
        expect(rejected).toMatchObject({ success: false })
        expect(JSON.stringify(rejected)).not.toContain(secret)
        expect(logged).not.toContain(secret)
        if (!rejected.success) {
          expect(rejected.error).toBe('SSH model discovery transport failed.')
        }
      }
      const refused = Object.assign(new Error(secret), { code: 'ECONNREFUSED' })
      const coded = await runSshModelProbe(
        'box',
        'claude',
        null,
        connectedExec('linux', () => Promise.reject(refused))
      )
      expect(coded).toEqual({ error: 'SSH model discovery transport failed (ECONNREFUSED).' })
      expect(JSON.stringify(coded)).not.toContain(secret)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('drops stdout, stderr, and a second-line API key when an SSH probe exits 1', async () => {
    const secret = 'synthetic-orca-gateway-value'
    const headerSecret = 'synthetic-x-api-key-value'
    const header = `Authorization: Bearer ignored\nX-Api-Key: ${headerSecret}`
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let channel: RemoteCommandChannel | null = null
      const exec = vi.fn((_command: string, _options?: SshExecOptions) => {
        const opened = openChannel()
        channel = opened
        return Promise.resolve(opened)
      })
      const pending = discoverModelsOverSsh({
        agentId: 'claude',
        cwd: '/srv/app',
        connectionId: 'box',
        windows: false,
        env: { ORCA_GATEWAY_VALUE: secret, ANTHROPIC_CUSTOM_HEADERS: header },
        runRemoteProbe: (connectionId, command, stdin) =>
          runSshModelProbe(connectionId, command, stdin, connectedExec('linux', exec))
      })
      await Promise.resolve()
      await Promise.resolve()
      const opened = requireChannel(channel)
      opened.emit('data', Buffer.from(`${secret}\n`))
      opened.stderr.emit('data', Buffer.from(`ANTHROPIC_CUSTOM_HEADERS=${header}\n`))
      opened.emit('close', 1)
      const failed = await pending
      const blob = `${JSON.stringify(failed)}\n${JSON.stringify(errorSpy.mock.calls)}`
      expect(failed).toMatchObject({ success: false })
      expect(blob).not.toContain(secret)
      expect(blob).not.toContain(headerSecret)
      expect(blob).not.toContain('X-Api-Key')
      expect(blob).not.toContain('ORCA_GATEWAY_VALUE')
      if (!failed.success) {
        expect(failed.error).toContain('exited with code 1')
      }
    } finally {
      errorSpy.mockRestore()
    }
  })
})

const BANNER_FREE_MODEL = 'banner-free-model'

function bannerFreeModelLine(): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      response: { models: [{ value: BANNER_FREE_MODEL, displayName: 'Banner Free' }] }
    }
  })
}

function discoverThroughShell(shell: string, home: string) {
  const claude = join(home, 'claude')
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' '${bannerFreeModelLine()}'\n`)
  chmodSync(claude, 0o755)
  let raw = ''
  let command = ''
  let status: number | null = null
  const exec = vi.fn((remote: string) => {
    command = remote
    const run = spawnSync('/bin/sh', ['-c', remote], {
      encoding: 'utf8',
      env: { HOME: home, SHELL: shell, PATH: '/bin:/usr/bin' }
    })
    raw = run.stdout ?? ''
    status = run.status
    const opened = openChannel()
    setImmediate(() => {
      if (run.stdout) {
        opened.emit('data', Buffer.from(run.stdout))
      }
      if (run.stderr) {
        opened.stderr.emit('data', Buffer.from(run.stderr))
      }
      opened.emit('close', run.status ?? 1)
    })
    return Promise.resolve(opened)
  })
  const result = discoverModelsOverSsh({
    agentId: 'claude',
    cwd: home,
    connectionId: 'box',
    windows: false,
    agentCommandOverride: quotePosixShell(claude),
    runRemoteProbe: (connectionId, probeCommand, stdin) =>
      runSshModelProbe(connectionId, probeCommand, stdin, connectedExec('linux', exec))
  })
  return result.then((discovered) => ({ discovered, raw, command, status }))
}

describe.skipIf(process.platform === 'win32')('SSH probe login shell capture', () => {
  it.skipIf(!existsSync('/bin/bash'))(
    'drops a bash login banner and still emits the closing fence',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-ssh-banner-'))
      try {
        writeFileSync(join(home, '.bash_profile'), "printf 'PROFILE_BANNER'")
        writeFileSync(join(home, '.bash_logout'), "printf 'LOGOUT_BANNER'")
        const { discovered, raw, command, status } = await discoverThroughShell('/bin/bash', home)
        expect(status, raw).toBe(0)
        expect(command).toContain('case "${SHELL##*/}" in')
        expect(command).toContain('__ORCA_SSH_CAPTURE_BEGIN_')
        expect(command).toContain('__ORCA_SSH_PROBE_CAPTURE_BEGIN_')
        expect(command).not.toContain('exec ')
        const probeEnd = raw.indexOf('__ORCA_SSH_PROBE_CAPTURE_END_')
        const logoutAt = raw.indexOf('LOGOUT_BANNER')
        const outerEnd = raw.indexOf('__ORCA_SSH_CAPTURE_END_')
        expect(raw).toContain('PROFILE_BANNER')
        expect(probeEnd).toBeGreaterThan(-1)
        expect(logoutAt).toBeGreaterThan(probeEnd)
        expect(outerEnd).toBeGreaterThan(logoutAt)
        expect(discovered.success).toBe(true)
        if (discovered.success) {
          expect(discovered.catalogOrigin).toBe('probe')
          expect(discovered.models.map((model) => model.id)).toContain(BANNER_FREE_MODEL)
        }
        const rendered = JSON.stringify(discovered)
        expect(rendered).not.toContain('PROFILE_BANNER')
        expect(rendered).not.toContain('LOGOUT_BANNER')
        expect(rendered).not.toContain('CAPTURE_')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it('does not ask fish, tcsh, or nu to parse the probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-fish-'))
    try {
      const shells = ['fish', 'tcsh', 'nu'].map((name) => {
        const path = join(root, name)
        writeFileSync(path, "#!/bin/sh\nprintf 'NONPOSIX_RAN'\nexit 9\n")
        chmodSync(path, 0o755)
        return path
      })
      for (const shell of shells) {
        const home = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
        try {
          const { discovered, raw, command, status } = await discoverThroughShell(shell, home)
          expect(status, `${shell}\n${raw}`).toBe(0)
          expect(command).toContain('/bin/sh -lc')
          expect(command).toContain('case "${SHELL##*/}" in')
          expect(raw).not.toContain('NONPOSIX_RAN')
          expect(raw).toContain('__ORCA_SSH_PROBE_CAPTURE_END_')
          expect(raw).toContain('__ORCA_SSH_CAPTURE_END_')
          expect(discovered.success).toBe(true)
          if (discovered.success) {
            expect(discovered.models.map((model) => model.id)).toContain(BANNER_FREE_MODEL)
          }
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
