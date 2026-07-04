import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { resolveRemoteNodePath } = await import('./ssh-remote-node-resolution')

const conn = {} as SshConnection

describe('resolveRemoteNodePath', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  // ── Path-probe strategy (runs first) ───────────────────────────────────

  it('resolves system node via the path probe', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/local/bin/node\n') // path probe
      .mockResolvedValueOnce('v20.0.0\n') // version check

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
  })

  it('probes mise install directories', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.local/share/mise/installs/node/20/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).toContain('"$HOME/.local/share/mise/installs/node"/*/bin/node')
  })

  it('probes asdf install directories', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.asdf/installs/nodejs/20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).toContain('"$HOME/.asdf/installs/nodejs"/*/bin/node')
  })

  it('probes volta bin directory', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.volta/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).toContain('$HOME/.volta/bin/node')
  })

  it('respects a custom NVM_DIR instead of hardcoding $HOME/.nvm', async () => {
    execCommandMock
      .mockResolvedValueOnce('/custom/nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).toContain('nvm_dirs=${NVM_DIR:-"$HOME/.nvm"}')
    expect(callScript).toContain('NVM_DIR[[:space:]]*=')
    expect(callScript).toContain('"$nvm_dir"/versions/node/*/bin/node')
  })

  it('quotes version-manager directory prefixes while leaving globs active', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.fnm/node-versions/v20.11.0/installation/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).toContain('"$HOME/.fnm/node-versions"/*/installation/bin/node')
    expect(callScript).toContain('"$HOME/.local/share/mise/installs/node"/*/bin/node')
    expect(callScript).toContain('"$HOME/.asdf/installs/nodejs"/*/bin/node')
  })

  it('does not depend on GNU sort when probing version-manager directories', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript).not.toContain('sort -V')
  })

  it('keeps the path-probe script successful when optional directories are missing', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    expect(callScript.trimEnd()).toMatch(/\ntrue$/)
  })

  it('expands tilde NVM_DIR assignments from shell dotfiles', async () => {
    execCommandMock
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    const home = mkdtempSync(path.join(os.tmpdir(), 'orca-nvm-probe-'))
    try {
      const nodePath = path.join(home, 'tilde-nvm/versions/node/v20.11.0/bin/node')
      mkdirSync(path.dirname(nodePath), { recursive: true })
      writeFileSync(nodePath, '#!/bin/sh\nprintf "v20.11.0\\n"\n')
      chmodSync(nodePath, 0o755)
      writeFileSync(path.join(home, '.zshrc'), 'export NVM_DIR=~/tilde-nvm\n')

      const output = execFileSync('/bin/sh', ['-c', callScript], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' }
      })

      expect(output.split('\n')).toContain(nodePath)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('joins probes with newlines, not ||, so a missing dir does not mask later probes', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockResolvedValueOnce('v20.0.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[0]![1] as string
    // Why: an `||` chain would stop after the first successful probe and hide
    // later version managers that may hold the first usable Node.
    expect(callScript).not.toMatch(/node\b.*\|\|/)
  })

  it('rejects a path-probe candidate whose version is below the minimum', async () => {
    // Probe returns two candidates; the first (v10) is too old, the second
    // (v20) must be selected instead.
    execCommandMock
      .mockResolvedValueOnce(
        '/home/u/.nvm/versions/node/v10.24.1/bin/node\n/home/u/.nvm/versions/node/v20.11.0/bin/node\n'
      )
      .mockResolvedValueOnce('v10.24.1\n') // first candidate fails the gate
      .mockResolvedValueOnce('v20.11.0\n') // second candidate passes

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )
  })

  it('accepts Node 18 (the exact minimum) as valid', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockResolvedValueOnce('v18.0.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
  })

  it('deduplicates repeated candidate paths before version-checking', async () => {
    // Why: some managers leave stale shims that resolve to the same binary;
    // we should not version-check the same path twice.
    execCommandMock
      .mockResolvedValueOnce('/usr/local/bin/node\n/usr/local/bin/node\n')
      .mockResolvedValueOnce('v20.0.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
    expect(execCommandMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the login shell when path probes find nothing', async () => {
    execCommandMock
      .mockResolvedValueOnce('\n') // path probe: empty
      .mockResolvedValueOnce('/bin/zsh') // $SHELL
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n') // command -v node
      .mockResolvedValueOnce('v20.11.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )

    expect(execCommandMock).toHaveBeenNthCalledWith(3, conn, `'/bin/zsh' -lc 'command -v node'`, {
      wrapCommand: false,
      timeoutMs: 8_000
    })
  })

  it('falls back to the login shell when every path-probe candidate is too old', async () => {
    execCommandMock
      .mockResolvedValueOnce('/old/node\n') // path probe
      .mockResolvedValueOnce('v10.24.1\n') // too old
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )
  })

  // ── Login-shell strategy (fallback) ───────────────────────────────────

  it('respects a non-default $SHELL instead of hardcoding bash', async () => {
    execCommandMock
      .mockResolvedValueOnce('\n') // path probe: empty
      .mockResolvedValueOnce('/usr/bin/fish') // $SHELL
      .mockResolvedValueOnce('/opt/homebrew/bin/node\n')
      .mockResolvedValueOnce('v22.0.0\n')

    await resolveRemoteNodePath(conn)

    expect(execCommandMock).toHaveBeenNthCalledWith(
      3,
      conn,
      `'/usr/bin/fish' -lc 'command -v node'`,
      { wrapCommand: false, timeoutMs: 8_000 }
    )
  })

  it('uses /bin/sh when the remote shell expansion falls back to it', async () => {
    execCommandMock
      .mockResolvedValueOnce('\n') // path probe: empty
      .mockResolvedValueOnce('/bin/sh\n') // ${SHELL:-/bin/sh}
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockResolvedValueOnce('v20.0.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
    expect(execCommandMock).toHaveBeenNthCalledWith(3, conn, `'/bin/sh' -c 'command -v node'`, {
      wrapCommand: false,
      timeoutMs: 8_000
    })
  })

  // ── Failure ───────────────────────────────────────────────────────────

  it('throws when both strategies find no usable node', async () => {
    execCommandMock
      .mockResolvedValueOnce('\n') // path probe: empty
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // command -v node: empty

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })

  it('throws when the path-probe exec fails and the login shell finds nothing', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('SSH exec channel failed')) // path probe errors
      .mockResolvedValueOnce('/bin/zsh') // $SHELL
      .mockResolvedValueOnce('\n') // command -v node: empty

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })

  it('keeps the default path-probe fallback for SSH session-limit-shaped errors', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    execCommandMock
      .mockRejectedValueOnce(sessionLimitError)
      .mockResolvedValueOnce('/bin/bash')
      .mockResolvedValueOnce('\n')

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })

  it('rethrows SSH session-limit errors from the path probe in strict mode', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    execCommandMock.mockRejectedValueOnce(sessionLimitError)

    await expect(
      resolveRemoteNodePath(conn, undefined, { rethrowSessionLimitErrors: true })
    ).rejects.toBe(sessionLimitError)
  })

  it('rethrows SSH session-limit errors from candidate version checks in strict mode', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    execCommandMock
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockRejectedValueOnce(sessionLimitError)

    await expect(
      resolveRemoteNodePath(conn, undefined, { rethrowSessionLimitErrors: true })
    ).rejects.toBe(sessionLimitError)
  })

  it('rethrows SSH session-limit errors from login-shell resolution in strict mode', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    execCommandMock.mockResolvedValueOnce('\n').mockRejectedValueOnce(sessionLimitError)

    await expect(
      resolveRemoteNodePath(conn, undefined, { rethrowSessionLimitErrors: true })
    ).rejects.toBe(sessionLimitError)
  })

  it('rethrows SSH session-limit errors from Windows node resolution in strict mode', async () => {
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    execCommandMock.mockRejectedValueOnce(sessionLimitError)

    await expect(
      resolveRemoteNodePath(conn, getRemoteHostPlatform('win32-x64'), {
        rethrowSessionLimitErrors: true
      })
    ).rejects.toBe(sessionLimitError)
  })

  it('surfaces an AbortError instead of not-found when the shared signal is aborted', async () => {
    // Why: in concurrent bootstrap a sibling probe aborts this resolution via
    // the shared signal. Each strategy catch swallows the injected AbortError,
    // so without re-raising it here the resolver would launder cancellation
    // into a fatal "Node.js not found" and defeat the sequential fallback.
    const controller = new AbortController()
    const abortError = Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
    execCommandMock.mockImplementation(() => {
      controller.abort()
      return Promise.reject(abortError)
    })

    await expect(
      resolveRemoteNodePath(conn, undefined, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('throws when every candidate across both strategies is below the minimum', async () => {
    execCommandMock
      .mockResolvedValueOnce('/old/node\n') // path probe
      .mockResolvedValueOnce('v8.17.0\n') // too old
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('/old/node2\n') // login shell
      .mockResolvedValueOnce('v6.17.0\n') // too old

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })
})
