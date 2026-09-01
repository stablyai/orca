// Host-private admission fingerprint: a sha256 over only the inputs that could
// change THIS launch. It is never logged, serialized, or returned to a client;
// the admission coordinator (U3) recomputes it under a lock to detect a relevant
// mutation between resolution and commit. Managed-provider inputs land in U3 —
// the `managedProvider` slot is reserved so its shape stays stable.

import { createHash } from 'node:crypto'
import type { BuiltInTuiAgent, TuiAgent } from '../../shared/types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'

export type AdmissionFingerprintBasis = 'explicit' | 'default' | 'snapshot'

export type AdmissionFingerprintInputs = {
  basis: AdmissionFingerprintBasis
  /** Digest of the resolved argv, and of the env this launch actually ships
   *  (a replay's remove-only authorization can drop a rotated entry while every
   *  coarse input stays identical). Both embed the volatile repo/worktree paths,
   *  so both are cleared in the config-only stable digest. */
  argvDigest: string
  envDigest: string
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  mode: 'built-in' | 'custom' | 'safe-fallback'
  /** Normalized definition digest (custom) or replay-policy digest (snapshot). */
  definitionDigest: string
  baseEnabled: boolean
  /** Applicable built-in command config (prefix override + default args) digest. */
  builtInCommandConfig: string
  variableValues: { repoPath: string | null; worktreePath: string | null }
  /** Authenticated remote-env authorization for this launch (full/withheld/none). */
  remoteEnvAuthorization: string
  /** Reserved for U3 managed-provider selection/defaults; empty until then. */
  managedProvider: string
  target: {
    platform: NodeJS.Platform
    execution: 'native' | 'wsl'
    shell: AgentStartupShell
    isRemote: boolean
    executionHostId: AgentLaunchExecutionHostId
    homePath: string | null
  }
  /** Transport-confidentiality capability, when known to the resolver. */
  transportConfidential: boolean | null
}

/** Deterministic canonical JSON: object keys are emitted in sorted order so the
 *  digest is stable across key-insertion order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

/** Compute the host-private admission fingerprint. Never log or serialize the
 *  return value or its source inputs. */
export function computeAdmissionFingerprint(inputs: AdmissionFingerprintInputs): string {
  return createHash('sha256').update(canonicalize(inputs)).digest('hex')
}

/** Stable digest of an object subset used inside the fingerprint (definition,
 *  built-in command config). Keeps raw values out of the exposed structure. */
export function digestObject(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
