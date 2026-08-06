import { execFileSync } from 'node:child_process'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import {
  buildWslCodexAppServerArgs,
  buildWslCodexIdentityArgs,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from '../codex-accounts/wsl-codex-command'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import {
  binaryStampsMatch,
  buildNativeCodexBinaryStamp,
  readCodexTrustGrantLedgerHome,
  type CodexTrustGrantBinaryStamp,
  type CodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

// Why: native sessions finish in ~100ms; WSL also pays cold-distro and
// login-shell startup, but both stay hard-bounded on launch prep.
const NATIVE_GRANT_TIMEOUT_MS = 10_000
const WSL_GRANT_TIMEOUT_MS = 30_000

export type CodexTrustGrantHost =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string; linuxRuntimeHome: string }

type CodexTrustGrantRequestInput = {
  runtimeHomePath: string
  managedCommand: string
  expectedTrustKeys: string[]
  useDefaultCodexHome?: boolean
}

export type ResolvedCodexTrustGrantHost = {
  binaryStamp: CodexTrustGrantBinaryStamp | null
  buildRequest: (input: CodexTrustGrantRequestInput) => CodexHookTrustGrantRequest
}

export function resolveCodexTrustGrantHost(host: CodexTrustGrantHost): ResolvedCodexTrustGrantHost {
  if (host.kind === 'wsl') {
    return {
      binaryStamp: buildWslCodexBinaryStamp(host.distro),
      buildRequest: (input) => ({
        invocation: {
          command: 'wsl.exe',
          args: buildWslCodexAppServerArgs(host.distro, host.linuxRuntimeHome),
          timeoutMs: WSL_GRANT_TIMEOUT_MS
        },
        hooksListCwd: host.linuxRuntimeHome,
        expectedTrustKeys: input.expectedTrustKeys,
        managedCommand: input.managedCommand
      })
    }
  }

  // Why: command resolution scans PATH/version-manager directories. Resolve
  // once per grant and reuse it for both the binary stamp and invocation.
  const command = resolveCodexCommand()
  return {
    binaryStamp: command === 'codex' ? null : buildNativeCodexBinaryStamp(command),
    buildRequest: (input) => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, ['app-server'])
      const useDefaultCodexHome = input.useDefaultCodexHome === true
      return {
        invocation: {
          command: spawnCmd,
          args: spawnArgs,
          ...(useDefaultCodexHome
            ? { envToDelete: ['CODEX_HOME'] }
            : { env: { CODEX_HOME: input.runtimeHomePath } }),
          timeoutMs: NATIVE_GRANT_TIMEOUT_MS
        },
        hooksListCwd: input.runtimeHomePath,
        expectedTrustKeys: input.expectedTrustKeys,
        managedCommand: input.managedCommand
      }
    }
  }
}

function buildWslCodexBinaryStamp(distro: string): CodexTrustGrantBinaryStamp | null {
  try {
    // Why: WSL PATH resolution happens inside the distro's login shell. The
    // resolved path plus CLI version detects upgrades without assuming UNC access.
    const output = execFileSync('wsl.exe', buildWslCodexIdentityArgs(distro), {
      encoding: 'utf-8',
      timeout: WSL_CODEX_AVAILABILITY_TIMEOUT_MS,
      windowsHide: true
    })
    const lineBreak = output.indexOf('\n')
    const path = lineBreak === -1 ? '' : output.slice(0, lineBreak).trim()
    const version = lineBreak === -1 ? '' : output.slice(lineBreak + 1).trim()
    return path && version ? { kind: 'wsl', distro, path, version } : null
  } catch {
    return null
  }
}

export function readCodexTrustGrantLedgerHomeMatchingStamp(
  runtimeHomePath: string,
  currentStamp: CodexTrustGrantBinaryStamp | null
): CodexTrustGrantLedgerHome | null {
  const home = readCodexTrustGrantLedgerHome(runtimeHomePath)
  return home && binaryStampsMatch(home.binary, currentStamp) ? home : null
}

export function readCurrentCodexTrustGrantLedgerHome(
  runtimeHomePath: string,
  host: CodexTrustGrantHost
): CodexTrustGrantLedgerHome | null {
  try {
    const home = readCodexTrustGrantLedgerHome(runtimeHomePath)
    if (!home) {
      // Why: fallback-only installs have no ledger. Avoid a synchronous PATH
      // and version-manager scan when there is no recorded stamp to validate.
      return null
    }
    return binaryStampsMatch(home.binary, resolveCodexTrustGrantHost(host).binaryStamp)
      ? home
      : null
  } catch {
    // Why: status is diagnostic and best-effort; unreadable ledger/binary
    // paths must trigger conservative self-hash handling, not throw.
    return null
  }
}
