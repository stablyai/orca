import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { AntigravityAccountTarget } from '../../shared/antigravity-account-types'
import { buildWslCapturedLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { getWslGuestEnvironment } from '../wsl/wsl-guest-environment'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  remainingAccountOperationMs,
  type AntigravityAccountOperation
} from './native-account-operation'

export type ResolvedAntigravityWslTarget = {
  distro: string
  uid: number
  home: string
  canonicalHome: string
  authorityId: string
  credentialPath: string
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  )
}

const IDENTITY_SCRIPT = [
  'PATH=/usr/bin:/bin; export PATH',
  'printf \'%s\\0%s\\0%s\\0%s\' "$WSL_DISTRO_NAME" "$(id -u)" "$HOME" "$(readlink -e -- "$HOME")"'
].join('\n')

export async function resolveAntigravityWslTarget(
  target: AntigravityAccountTarget,
  operation: AntigravityAccountOperation
): Promise<ResolvedAntigravityWslTarget> {
  if (process.platform !== 'win32') {
    throw new Error('WSL account management requires a Windows execution host')
  }
  if (target.runtime !== 'wsl') {
    throw new Error('Invalid WSL account target')
  }
  const distro = target.wslDistro || undefined
  if (distro && (distro.length > 256 || /[\\/]/.test(distro) || hasControlCharacters(distro))) {
    throw new Error('Invalid WSL account target')
  }
  const environment = await getWslGuestEnvironment(distro, remainingAccountOperationMs(operation), {
    fresh: true,
    signal: operation.signal
  })
  if (!environment) {
    throw new Error('Unable to resolve WSL account target login HOME')
  }
  const captured = buildWslCapturedLoginShellCommand(IDENTITY_SCRIPT)
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: captured.command,
    timeoutMs: remainingAccountOperationMs(operation),
    signal: operation.signal,
    maxOutputBytes: 16_384,
    killOnOutputLimit: true
  })
  remainingAccountOperationMs(operation)
  const values = captured.readStdout(result.stdout)?.split('\0')
  const [actualDistro, uidText, home, canonicalHome] = values ?? []
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    values?.length !== 4 ||
    !actualDistro ||
    actualDistro.length > 256 ||
    /[\\/]/.test(actualDistro) ||
    hasControlCharacters(actualDistro) ||
    (distro && distro.toLowerCase() !== actualDistro.toLowerCase()) ||
    !uidText ||
    !/^\d+$/.test(uidText) ||
    !Number.isSafeInteger(Number(uidText)) ||
    !home ||
    home === '/' ||
    !home.startsWith('/') ||
    hasControlCharacters(home) ||
    posix.normalize(home) !== home ||
    home !== canonicalHome ||
    home !== environment.home
  ) {
    throw new Error('Unable to verify WSL account target identity')
  }
  const uid = Number(uidText)
  const authorityId = createHash('sha256')
    .update(JSON.stringify(['v1', 'wsl', actualDistro.toLowerCase(), uid, canonicalHome]))
    .digest('hex')
  return {
    distro: actualDistro,
    uid,
    home,
    canonicalHome,
    authorityId,
    credentialPath: posix.join(
      canonicalHome,
      '.gemini',
      'antigravity-cli',
      'antigravity-oauth-token'
    )
  }
}
