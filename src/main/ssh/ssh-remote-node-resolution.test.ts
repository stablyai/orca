import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { resolveRemoteNodePath } = await import('./ssh-remote-node-resolution')

const conn = {} as SshConnection

describe('resolveRemoteNodePath', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  // ── Login-shell strategy ──────────────────────────────────────────────

  it('resolves node via the user login shell and version-checks the result', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/zsh') // $SHELL
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n') // command -v node
      .mockResolvedValueOnce('v20.11.0\n') // node --version

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )

    // Why: the login-shell probe must bypass wrapRemoteCommandForPosixShell so
    // the user's own shell sources its init files (nvm.sh / mise activate).
    expect(execCommandMock).toHaveBeenNthCalledWith(2, conn, `'/bin/zsh' -lc 'command -v node'`, {
      wrapCommand: false,
      timeoutMs: 8_000
    })
  })

  it('respects a non-default $SHELL instead of hardcoding bash', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/bin/fish') // $SHELL
      .mockResolvedValueOnce('/opt/homebrew/bin/node\n')
      .mockResolvedValueOnce('v22.0.0\n')

    await resolveRemoteNodePath(conn)

    expect(execCommandMock).toHaveBeenNthCalledWith(
      2,
      conn,
      `'/usr/bin/fish' -lc 'command -v node'`,
      { wrapCommand: false, timeoutMs: 8_000 }
    )
  })

  it('falls back to /bin/sh when $SHELL is unset', async () => {
    execCommandMock
      .mockResolvedValueOnce('') // empty $SHELL → falls back to /bin/sh via ${SHELL:-/bin/sh}
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockResolvedValueOnce('v18.19.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
  })

  it('falls through to path probes when the login shell finds a too-old node', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v10.24.1/bin/node\n') // login shell: node 10
      .mockResolvedValueOnce('v10.24.1\n') // version check fails (< 18)
      // Strategy 2: path probe script returns a modern node.
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin/node'
    )
  })

  it('falls through to path probes when the login shell finds no node', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/zsh') // $SHELL
      .mockResolvedValueOnce('\n') // command -v node: empty
      // Path probe finds mise-managed node.
      .mockResolvedValueOnce('/home/u/.local/share/mise/installs/node/20/bin/node\n')
      .mockResolvedValueOnce('v20.10.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe(
      '/home/u/.local/share/mise/installs/node/20/bin/node'
    )
  })

  it('falls through to path probes when the login-shell exec times out', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('SSH exec channel timed out')) // $SHELL probe hangs
      .mockResolvedValueOnce('/usr/local/bin/node\n') // path probe
      .mockResolvedValueOnce('v20.0.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
  })

  it('probes mise install directories', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('/home/u/.local/share/mise/installs/node/20/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[2]![1] as string
    expect(callScript).toContain('$HOME/.local/share/mise/installs/node/*/bin/node')
  })

  it('probes asdf install directories', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('/home/u/.asdf/installs/nodejs/20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[2]![1] as string
    expect(callScript).toContain('$HOME/.asdf/installs/nodejs/*/bin/node')
  })

  it('probes volta bin directory', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('/home/u/.volta/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[2]![1] as string
    expect(callScript).toContain('$HOME/.volta/bin/node')
  })

  it('respects a custom NVM_DIR instead of hardcoding $HOME/.nvm', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('/custom/nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[2]![1] as string
    expect(callScript).toContain('${NVM_DIR:-$HOME/.nvm}/versions/node/*/bin/node')
  })

  it('uses version sort so nvm picks v20 over v9 (not alphabetical)', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('/home/u/.nvm/versions/node/v20.11.0/bin/node\n')
      .mockResolvedValueOnce('v20.11.0\n')

    await resolveRemoteNodePath(conn)

    const callScript = execCommandMock.mock.calls[2]![1] as string
    expect(callScript).toMatch(/sort -V/)
  })

  it('rejects a path-probe candidate whose version is below the minimum', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      // Probe returns two candidates; the first (v10) is too old, the second
      // (v20) must be selected instead.
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
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('/usr/local/bin/node\n')
      .mockResolvedValueOnce('v18.0.0\n')

    await expect(resolveRemoteNodePath(conn)).resolves.toBe('/usr/local/bin/node')
  })

  // ── Failure ───────────────────────────────────────────────────────────

  it('throws when both strategies find no usable node', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('\n') // login shell: no node
      .mockResolvedValueOnce('\n') // path probe: empty
      .mockRejectedValueOnce(new Error('no version')) // version check on nothing

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })

  it('throws when every candidate is below the minimum version', async () => {
    execCommandMock
      .mockResolvedValueOnce('/bin/bash') // $SHELL
      .mockResolvedValueOnce('/old/node\n') // login shell
      .mockResolvedValueOnce('v8.17.0\n') // too old
      .mockResolvedValueOnce('/old/node2\n') // path probe
      .mockResolvedValueOnce('v6.17.0\n') // too old

    await expect(resolveRemoteNodePath(conn)).rejects.toThrow(/Node\.js not found/)
  })
})
