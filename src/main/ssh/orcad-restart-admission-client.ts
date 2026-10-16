/**
 * The client half of `orcad.restartAdmission`: reserve a restart on the serving orcad, then let
 * that orcad end itself. A host without the capability, or any lost answer, never reserves.
 */
import { ORCAD_RESTART_ADMISSION_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import {
  ORCAD_RESTART_ADMISSION_METHOD,
  OrcadRestartAdmissionResultSchema,
  type OrcadRestartAdmissionParams,
  type OrcadRestartAdmissionResult
} from '../../shared/orcad-restart-admission'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import { errorMessage } from '../../shared/error-message'

export type OrcadRestartReservation =
  | { status: 'reserved'; token: string; census: OrcadTerminalCensus }
  /** `census` when the server counted before refusing, so terminal deferrals keep their codes. */
  | { status: 'defer'; reason: string; census?: OrcadTerminalCensus }

export type OrcadRestartCommit = 'committed' | 'refused' | 'unknown'

/** One serving orcad's restart admission; `unknown` means the server may have begun shutdown. */
export type OrcadRestartAdmissionPort = {
  reserve(force: boolean): Promise<OrcadRestartReservation>
  commit(token: string): Promise<OrcadRestartCommit>
  /** Best effort: the server's reservation TTL frees it anyway. */
  release(token: string): Promise<void>
}

/** Runs one request on a connection to the incumbent, opening and closing it as the host needs. */
export type OrcadIncumbentConnector = <T>(
  run: (connection: PairedRuntimeConnection) => Promise<T>
) => Promise<T>

// Reserve drains idle providers for up to 5s before counting, and must answer inside its 30s TTL.
const RESERVE_TIMEOUT_MS = 20_000
const COMMIT_TIMEOUT_MS = 10_000
const RELEASE_TIMEOUT_MS = 5_000

async function requestOrcadRestartAdmission(
  connection: PairedRuntimeConnection,
  params: OrcadRestartAdmissionParams,
  timeoutMs: number
): Promise<OrcadRestartAdmissionResult> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    connection,
    ORCAD_RESTART_ADMISSION_METHOD,
    params,
    timeoutMs,
    (status) => {
      if (
        !status.ok ||
        !status.result.capabilities?.includes(ORCAD_RESTART_ADMISSION_RUNTIME_CAPABILITY)
      ) {
        throw new Error('This Orca server cannot reserve a safe restart.')
      }
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return OrcadRestartAdmissionResultSchema.parse(response.result)
}

export function orcadRestartAdmissionPort(
  connect: OrcadIncumbentConnector,
  activatedAt: number
): OrcadRestartAdmissionPort {
  return {
    async reserve(force) {
      try {
        const result = await connect((connection) =>
          requestOrcadRestartAdmission(
            connection,
            { action: 'reserve', activatedAt, ...(force ? { force: true } : {}) },
            RESERVE_TIMEOUT_MS
          )
        )
        if (result.status === 'reserved' && result.token && result.census) {
          return { status: 'reserved', token: result.token, census: result.census }
        }
        return {
          status: 'defer',
          reason: result.reason ?? 'The Orca server did not reserve a restart.',
          ...(result.census ? { census: result.census } : {})
        }
      } catch (error) {
        return {
          status: 'defer',
          reason: `The Orca server did not reserve a safe restart: ${errorMessage(error)}`
        }
      }
    },
    async commit(token) {
      try {
        const result = await connect((connection) =>
          requestOrcadRestartAdmission(connection, { action: 'commit', token }, COMMIT_TIMEOUT_MS)
        )
        return result.status === 'committed' ? 'committed' : 'refused'
      } catch {
        return 'unknown'
      }
    },
    async release(token) {
      await connect((connection) =>
        requestOrcadRestartAdmission(connection, { action: 'release', token }, RELEASE_TIMEOUT_MS)
      ).catch(() => undefined)
    }
  }
}
