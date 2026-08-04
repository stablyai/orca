import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executeFilesystemHostOperation,
  FilesystemHostOperationError
} from './filesystem-host-operation'

describe('executeFilesystemHostOperation', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-filesystem-host-'))
    roots.push(root)
    return root
  }

  it('reads a bounded orca.yaml through an opened descriptor', () => {
    const root = createRoot()
    const path = join(root, 'orca.yaml')
    writeFileSync(path, 'hooks:\n  enabled: true\n')

    expect(
      executeFilesystemHostOperation({ kind: 'read-orca-yaml', path, maxBytes: 1_024 })
    ).toEqual({ kind: 'read-orca-yaml', contents: 'hooks:\n  enabled: true\n' })
  })

  it('rejects general file reads and oversized YAML', () => {
    const root = createRoot()
    const unrelated = join(root, 'secrets.txt')
    const yaml = join(root, 'orca.yaml')
    writeFileSync(unrelated, 'secret')
    writeFileSync(yaml, '12345')

    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-orca-yaml',
        path: unrelated,
        maxBytes: 100
      })
    ).toThrowError(FilesystemHostOperationError)
    expect(() =>
      executeFilesystemHostOperation({ kind: 'read-orca-yaml', path: yaml, maxBytes: 4 })
    ).toThrowError(expect.objectContaining({ code: 'too-large' }))
  })

  it('reads only the typed bounded keybindings file', () => {
    const root = createRoot()
    const path = join(root, 'keybindings.json')
    writeFileSync(path, '{"version":1}')

    expect(
      executeFilesystemHostOperation({ kind: 'read-keybindings', path, maxBytes: 1_024 })
    ).toEqual({ kind: 'read-keybindings', contents: '{"version":1}' })
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-keybindings',
        path: join(root, 'settings.json'),
        maxBytes: 1_024
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('prepares legacy keybindings inside the filesystem child', () => {
    const root = createRoot()
    const path = join(root, '.orca', 'keybindings.json')

    const result = executeFilesystemHostOperation({
      kind: 'prepare-keybindings',
      path,
      platform: 'linux',
      legacyOverrides: { 'tab.nextAllTypes': ['Mod+K'] },
      seedLegacyTabSwitchBindings: false
    })

    expect(result).toMatchObject({
      kind: 'prepare-keybindings',
      seedCompleted: false,
      contents: expect.stringContaining('Mod+K')
    })
  })

  it('reads only declared snapshot files and preserves raw bytes', () => {
    const root = createRoot()
    const path = join(root, 'minimax-session-cookie.enc')
    const contents = Buffer.from([0, 1, 2, 255])
    writeFileSync(path, contents)

    expect(
      executeFilesystemHostOperation({
        kind: 'read-snapshot-file',
        path,
        fileKind: 'minimax-cookie'
      })
    ).toEqual({ kind: 'read-snapshot-file', contentsBase64: contents.toString('base64') })
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-snapshot-file',
        path: join(root, 'secrets.txt'),
        fileKind: 'minimax-cookie'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))

    const speechPath = join(root, 'openai-speech-token.enc')
    writeFileSync(speechPath, contents)
    expect(
      executeFilesystemHostOperation({
        kind: 'read-snapshot-file',
        path: speechPath,
        fileKind: 'openai-speech-key'
      })
    ).toEqual({ kind: 'read-snapshot-file', contentsBase64: contents.toString('base64') })
  })

  it('prepares only the typed rate-limit PTY cwd', () => {
    const root = createRoot()
    const path = join(root, 'rate-limit-pty-cwd')

    expect(executeFilesystemHostOperation({ kind: 'prepare-rate-limit-pty-cwd', path })).toEqual({
      kind: 'prepare-rate-limit-pty-cwd',
      canonicalPath: realpathSync(path)
    })
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'prepare-rate-limit-pty-cwd',
        path: join(root, 'unrelated')
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('canonicalizes and classifies existing paths', () => {
    const root = createRoot()

    const canonical = executeFilesystemHostOperation({ kind: 'canonicalize-path', path: root })
    const classified = executeFilesystemHostOperation({ kind: 'classify-path', path: root })

    // Why pinned to realpathSync, not expect.any(String): the callers that moved into the host
    // used this exact implementation, and realpathSync.native diverges from it on Windows.
    expect(canonical).toEqual({ kind: 'canonicalize-path', canonicalPath: realpathSync(root) })
    expect(classified).toEqual({ kind: 'classify-path', deviceId: expect.any(String) })
  })

  it('resolves only declared CLI commands through the supplied search roots', () => {
    const root = createRoot()
    const executableName = process.platform === 'win32' ? 'codex.cmd' : 'codex'
    const executablePath = join(root, executableName)
    writeFileSync(executablePath, '', { mode: 0o700 })

    expect(
      executeFilesystemHostOperation({
        kind: 'resolve-cli-command',
        path: root,
        commandName: 'codex',
        pathEnvironment: root
      })
    ).toEqual({ kind: 'resolve-cli-command', command: executablePath })
  })

  it('writes Gemini OAuth credentials as an owner-only atomic file', () => {
    const root = createRoot()
    const path = join(root, 'oauth_creds.json')

    expect(
      executeFilesystemHostOperation({
        kind: 'write-rate-limit-credential',
        path,
        fileKind: 'gemini-oauth-credentials',
        contents: JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expiry_date: 123
        })
      })
    ).toEqual({ kind: 'write-rate-limit-credential' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_date: 123
    })
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('hardens an OpenCode credential without changing its third-party directory mode', () => {
    const root = createRoot()
    const path = join(root, 'auth.json')
    if (process.platform !== 'win32') {
      chmodSync(root, 0o755)
    }

    executeFilesystemHostOperation({
      kind: 'write-rate-limit-credential',
      path,
      fileKind: 'opencode-auth',
      contents: '{"google":{"type":"oauth"}}'
    })

    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o755)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects malformed or misrouted rate-limit credential writes', () => {
    const root = createRoot()

    expect(() =>
      executeFilesystemHostOperation({
        kind: 'write-rate-limit-credential',
        path: join(root, 'oauth_creds.json'),
        fileKind: 'gemini-oauth-credentials',
        contents: '{}'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'write-rate-limit-credential',
        path: join(root, 'unrelated.json'),
        fileKind: 'opencode-auth',
        contents: '{}'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('returns stable error classes without raw path disclosure', () => {
    const root = createRoot()
    const missing = join(root, 'missing')

    try {
      executeFilesystemHostOperation({ kind: 'canonicalize-path', path: missing })
      throw new Error('Expected canonicalization to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing' })
      expect((error as Error).message).not.toContain(missing)
    }
  })
})
