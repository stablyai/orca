import { runProcess } from '../../shared/child-process/run-process'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import {
  buildWslCodexAppServerArgs,
  buildWslCodexIdentityProbe,
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

/**
 * Resolves the host that runs the codex binary for a grant session.
 *
 * Async because the WSL identity probe shells into the distro; #16441 measured
 * a 15s main-thread stall when launch prep did this work synchronously.
 */
export async function resolveCodexTrustGrantHost(
  host: CodexTrustGrantHost
): Promise<ResolvedCodexTrustGrantHost> {
  if (host.kind === 'wsl') {
    return {
      binaryStamp: await buildWslCodexBinaryStamp(host.distro),
      buildRequest: (input) => ({
        invocation: {
          command: 'wsl.exe',
          // Why null: the guest resolves `codex` inside the distro, so a host path pairs nothing.
          cliPath: null,
          args: buildWslCodexAppServerArgs(host.distro, host.linuxRuntimeHome),
          timeoutMs: WSL_GRANT_TIMEOUT_MS
        },
        hooksListCwd: host.linuxRuntimeHome,
        expectedTrustKeys: input.expectedTrustKeys,
        managedCommand: input.managedCommand
      })
    }
  }

  return resolveNativeCodexTrustGrantHost()
}

export function resolveNativeCodexTrustGrantHost(): ResolvedCodexTrustGrantHost {
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
          cliPath: command,
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

async function buildWslCodexBinaryStamp(
  distro: string
): Promise<CodexTrustGrantBinaryStamp | null> {
  try {
    // Why: WSL PATH resolution happens inside the distro's login shell. The
    // resolved path plus CLI version detects upgrades without assuming UNC access.
    const probe = buildWslCodexIdentityProbe(distro)
    const result = await runProcess({
      program: 'wsl.exe',
      args: probe.args,
      timeoutMs: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    // Why: the split below is positional, so login-shell rc output ahead of the
    // payload would silently become the "path" and destabilize the stamp.
    const output = probe.readStdout(result.stdout)
    if (output === null) {
      return null
    }
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

/** Native-only: the WSL stamp needs a subprocess, and status reads must stay
 *  synchronous for the hook-status readers that never target a distro. */
export function readCurrentNativeCodexTrustGrantLedgerHome(
  runtimeHomePath: string
): CodexTrustGrantLedgerHome | null {
  try {
    const home = readCodexTrustGrantLedgerHome(runtimeHomePath)
    if (!home) {
      // Why: fallback-only installs have no ledger. Avoid a synchronous PATH
      // and version-manager scan when there is no recorded stamp to validate.
      return null
    }
    return binaryStampsMatch(home.binary, resolveNativeCodexTrustGrantHost().binaryStamp)
      ? home
      : null
  } catch {
    // Why: status is diagnostic and best-effort; unreadable ledger/binary
    // paths must trigger conservative self-hash handling, not throw.
    return null
  }
}
