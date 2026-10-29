import { runProcess } from '@orca/process-host'
import {
  buildWslCodexAppServerArgs,
  buildWslCodexIdentityProbe,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from '../codex-accounts/wsl-codex-command'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import {
  binaryStampsMatch,
  readCodexTrustGrantLedgerHome,
  type CodexTrustGrantBinaryStamp,
  type CodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

// Allow cold-distro and login-shell startup while bounding launch preparation.
const WSL_GRANT_TIMEOUT_MS = 30_000

/** Only WSL runs a grant session; native homes approve with the hash Codex lists. */
export type CodexTrustGrantHost = { kind: 'wsl'; distro: string; linuxRuntimeHome: string }

type CodexTrustGrantRequestInput = {
  runtimeHomePath: string
  managedCommand: string
  expectedTrustKeys: string[]
}

export type ResolvedCodexTrustGrantHost = {
  binaryStamp: CodexTrustGrantBinaryStamp | null
  buildRequest: (input: CodexTrustGrantRequestInput) => CodexHookTrustGrantRequest
}

export async function resolveCodexTrustGrantHost(
  host: CodexTrustGrantHost
): Promise<ResolvedCodexTrustGrantHost> {
  return {
    binaryStamp: await buildWslCodexBinaryStamp(host.distro),
    buildRequest: (input) => ({
      invocation: {
        command: 'wsl.exe',
        // The guest resolves codex; a host CLI path cannot identify it.
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

async function buildWslCodexBinaryStamp(
  distro: string
): Promise<CodexTrustGrantBinaryStamp | null> {
  try {
    // Resolve the guest CLI path and version without requiring UNC access.
    const probe = buildWslCodexIdentityProbe(distro)
    const result = await runProcess({
      program: 'wsl.exe',
      args: probe.args,
      cwd: resolveWslInteropSpawnCwd(),
      timeoutMs: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    // Strip login-shell banners before parsing positional identity fields.
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
