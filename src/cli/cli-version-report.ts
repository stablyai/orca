import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../shared/protocol-version'
import type { CliClientVersionInfo, CliStatusResult } from '../shared/runtime-types'
import { readOrcaCliVersion } from './cli-version'
import { isStandaloneCli } from './standalone-cli-mode'

export type CliVersionReport = {
  client: CliClientVersionInfo
  server:
    | { reachable: false; error?: string }
    | ({ reachable: true } & Pick<
        CliStatusResult['runtime'],
        'runtimeId' | 'appVersion' | 'runtimeProtocolVersion' | 'minCompatibleRuntimeClientVersion'
      >)
}

const VERSION_PROBE_TIMEOUT_MS = 2_000

export function readCliClientVersionInfo(): CliClientVersionInfo {
  return {
    version: readOrcaCliVersion(),
    standalone: isStandaloneCli(),
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeServerVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
  }
}

// Why: best effort — an unreachable server still yields the client half, which is what an
// install check needs; the server half answers "does this CLI match what it will talk to".
export async function buildCliVersionReport(
  readStatus: () => Promise<CliStatusResult>
): Promise<CliVersionReport> {
  const client = readCliClientVersionInfo()
  try {
    const status = await withTimeout(readStatus(), VERSION_PROBE_TIMEOUT_MS)
    if (!status.runtime.reachable) {
      return { client, server: { reachable: false } }
    }
    const { runtimeId, appVersion, runtimeProtocolVersion, minCompatibleRuntimeClientVersion } =
      status.runtime
    return {
      client,
      server: {
        reachable: true,
        runtimeId,
        ...(appVersion !== undefined ? { appVersion } : {}),
        ...(runtimeProtocolVersion !== undefined ? { runtimeProtocolVersion } : {}),
        ...(minCompatibleRuntimeClientVersion !== undefined
          ? { minCompatibleRuntimeClientVersion }
          : {})
      }
    }
  } catch (error) {
    return {
      client,
      server: { reachable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer from the Orca runtime within ${timeoutMs}ms.`)),
      timeoutMs
    )
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
