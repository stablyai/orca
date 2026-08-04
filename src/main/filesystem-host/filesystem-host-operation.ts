import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type {
  FilesystemHostErrorCode,
  FilesystemHostOperation,
  FilesystemHostResult,
  FilesystemSnapshotFileKind
} from '../../shared/filesystem-host-protocol'
import { FILESYSTEM_HOST_MAX_TEXT_BYTES } from '../../shared/filesystem-host-protocol'
import { LEGACY_TAB_SWITCH_BINDINGS, type KeybindingOverrides } from '../../shared/keybindings'
import {
  migrateLegacyKeybindings,
  seedLegacyTabSwitchBindings
} from '../keybindings/keybinding-file'

export class FilesystemHostOperationError extends Error {
  constructor(
    readonly code: FilesystemHostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FilesystemHostOperationError'
  }
}

function prepareRateLimitPtyCwd(path: string): FilesystemHostResult {
  if (basename(path) !== 'rate-limit-pty-cwd') {
    throw new FilesystemHostOperationError('invalid', 'Expected a rate-limit PTY cwd path')
  }
  try {
    mkdirSync(path, { recursive: true })
    const canonicalPath = realpathSync(path)
    if (!statSync(canonicalPath).isDirectory()) {
      throw new FilesystemHostOperationError('invalid', 'Expected a rate-limit PTY cwd directory')
    }
    return { kind: 'prepare-rate-limit-pty-cwd', canonicalPath }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  }
}

function classifyError(error: unknown): FilesystemHostOperationError {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const classified: FilesystemHostErrorCode =
    code === 'ENOENT'
      ? 'missing'
      : code === 'EACCES' || code === 'EPERM'
        ? 'denied'
        : code === 'ENOTDIR' || code === 'EISDIR'
          ? 'not-directory'
          : code === 'EINVAL'
            ? 'invalid'
            : 'io'
  return new FilesystemHostOperationError(
    classified,
    `Filesystem operation failed${code ? ` (${code})` : ''}`
  )
}

function readBoundedTextFile(
  path: string,
  maxBytes: number,
  expectedBasename: string,
  kind: 'read-orca-yaml' | 'read-keybindings'
): FilesystemHostResult {
  if (basename(path).toLowerCase() !== expectedBasename) {
    throw new FilesystemHostOperationError('invalid', `Expected a ${expectedBasename} path`)
  }
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new FilesystemHostOperationError(
        'invalid',
        `Expected a regular ${expectedBasename} file`
      )
    }
    if (stat.size > maxBytes) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    const contents = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(contents) > maxBytes) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    return { kind, contents }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

function prepareKeybindings(
  operation: Extract<FilesystemHostOperation, { kind: 'prepare-keybindings' }>
): FilesystemHostResult {
  migrateLegacyKeybindings(
    operation.path,
    operation.platform,
    operation.legacyOverrides as KeybindingOverrides | undefined
  )
  if (operation.seedLegacyTabSwitchBindings) {
    seedLegacyTabSwitchBindings(operation.path, operation.platform, LEGACY_TAB_SWITCH_BINDINGS)
  }
  if (!existsSync(operation.path)) {
    return {
      kind: 'prepare-keybindings',
      contents: null,
      seedCompleted: operation.seedLegacyTabSwitchBindings
    }
  }
  const result = readBoundedTextFile(
    operation.path,
    FILESYSTEM_HOST_MAX_TEXT_BYTES,
    'keybindings.json',
    'read-keybindings'
  )
  return {
    kind: 'prepare-keybindings',
    contents: result.kind === 'read-keybindings' ? result.contents : null,
    seedCompleted: operation.seedLegacyTabSwitchBindings
  }
}

const SNAPSHOT_BASENAME_BY_KIND: Record<FilesystemSnapshotFileKind, string> = {
  'claude-credentials': '.credentials.json',
  'codex-auth': 'auth.json',
  'gemini-auth': 'auth.json',
  'gemini-oauth-credentials': 'oauth_creds.json',
  'grok-auth': 'auth.json',
  'kimi-credentials': 'kimi-code.json',
  'minimax-cookie': 'minimax-session-cookie.enc',
  'openai-speech-key': 'openai-speech-token.enc'
}

function readBoundedSnapshotFile(
  path: string,
  fileKind: FilesystemSnapshotFileKind
): FilesystemHostResult {
  const expectedBasename = SNAPSHOT_BASENAME_BY_KIND[fileKind]
  if (basename(path).toLowerCase() !== expectedBasename) {
    throw new FilesystemHostOperationError('invalid', `Expected a ${expectedBasename} path`)
  }
  let descriptor: number | null = null
  try {
    if (fileKind === 'minimax-cookie') {
      try {
        hardenExistingSecureFile(path)
      } catch {
        // Why: legacy hydration treated read-time permission repair as best-effort.
      }
    }
    descriptor = openSync(path, constants.O_RDONLY)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new FilesystemHostOperationError(
        'invalid',
        `Expected a regular ${expectedBasename} file`
      )
    }
    if (stat.size > FILESYSTEM_HOST_MAX_TEXT_BYTES) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    const contents = readFileSync(descriptor)
    if (contents.byteLength > FILESYSTEM_HOST_MAX_TEXT_BYTES) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    return { kind: 'read-snapshot-file', contentsBase64: contents.toString('base64') }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

function writeRateLimitCredential(
  operation: Extract<FilesystemHostOperation, { kind: 'write-rate-limit-credential' }>
): FilesystemHostResult {
  const expectedBasename =
    operation.fileKind === 'gemini-oauth-credentials' ? 'oauth_creds.json' : 'auth.json'
  if (basename(operation.path).toLowerCase() !== expectedBasename) {
    throw new FilesystemHostOperationError('invalid', `Expected a ${expectedBasename} path`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(operation.contents)
  } catch {
    throw new FilesystemHostOperationError('invalid', 'Expected a JSON credential document')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FilesystemHostOperationError('invalid', 'Expected a JSON credential object')
  }
  if (operation.fileKind === 'gemini-oauth-credentials') {
    const credentials = parsed as Record<string, unknown>
    if (
      typeof credentials.access_token !== 'string' ||
      credentials.access_token.length === 0 ||
      typeof credentials.refresh_token !== 'string' ||
      credentials.refresh_token.length === 0 ||
      typeof credentials.expiry_date !== 'number' ||
      !Number.isFinite(credentials.expiry_date)
    ) {
      throw new FilesystemHostOperationError('invalid', 'Invalid Gemini OAuth credentials')
    }
  }
  writeSecureFile(operation.path, operation.contents, {
    // Why: OpenCode owns this shared provider directory; only Orca's credential file is ours to harden.
    hardenParentDirectory: operation.fileKind !== 'opencode-auth'
  })
  return { kind: 'write-rate-limit-credential' }
}

export function executeFilesystemHostOperation(
  operation: FilesystemHostOperation
): FilesystemHostResult {
  try {
    switch (operation.kind) {
      case 'canonicalize-path':
        // Why not realpathSync.native: every caller moved in here compared the result against
        // textually-recorded roots. `.native` folds Windows casing and rewrites a mapped drive
        // to UNC, so it would change allow-list and PTY-cwd outcomes this move must not touch.
        return {
          kind: 'canonicalize-path',
          canonicalPath: realpathSync(operation.path)
        }
      case 'classify-path':
        return { kind: 'classify-path', deviceId: String(statSync(operation.path).dev) }
      case 'read-orca-yaml':
        return readBoundedTextFile(operation.path, operation.maxBytes, 'orca.yaml', operation.kind)
      case 'read-keybindings':
        return readBoundedTextFile(
          operation.path,
          operation.maxBytes,
          'keybindings.json',
          operation.kind
        )
      case 'prepare-keybindings':
        return prepareKeybindings(operation)
      case 'read-snapshot-file':
        return readBoundedSnapshotFile(operation.path, operation.fileKind)
      case 'prepare-rate-limit-pty-cwd':
        return prepareRateLimitPtyCwd(operation.path)
      case 'resolve-cli-command':
        return {
          kind: 'resolve-cli-command',
          command: resolveCliCommand(operation.commandName, {
            homePath: operation.path,
            pathEnv: operation.pathEnvironment
          })
        }
      case 'write-rate-limit-credential':
        return writeRateLimitCredential(operation)
    }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  }
}
