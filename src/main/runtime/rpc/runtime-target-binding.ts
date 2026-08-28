import { realpathSync } from 'node:fs'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  isOrchestrationMutation,
  ORCHESTRATION_MUTATION_METHODS
} from '../../../shared/orchestration-rpc-contract'

/** Correction — a candidate-scoped mutation must prove it reached the runtime it
 *  meant to reach, BEFORE it mutates anything.
 *
 *  The failure this closes: a certification command aimed at an isolated
 *  candidate resolved its socket from the wrong environment variable and landed
 *  on the NATIVE runtime instead. It happened to fail on a not-found lookup, so
 *  nothing was written — but nothing in the path would have stopped a write.
 *
 *  Why the client stamps this and not the operator: an OPTIONAL declaration
 *  closes nothing, because the invocation that caused the incident declared
 *  nothing. The CLI therefore stamps the state root it actually resolved onto
 *  every request, and the runtime compares it against the state root it is
 *  actually running out of — two facts neither side can assert about the other.
 *  For certification verbs the stamp is REQUIRED, so a client too old to send
 *  one cannot drive certification against an unverified runtime.
 */

export class RuntimeTargetMismatch extends Error {
  readonly code = 'runtime_target_mismatch'
  constructor(
    message: string,
    readonly data: Record<string, unknown>
  ) {
    super(message)
    this.name = 'RuntimeTargetMismatch'
  }
}

/** How the request reached this runtime, which decides what "aimed at the right
 *  runtime" can even mean.
 *
 *  `local_socket` is the incident's transport: any process on the box connects
 *  to whichever socket path it resolved, and a mis-resolved path silently
 *  reaches a different runtime. Nothing about the connection proves the target,
 *  so the caller must name the state root it resolved.
 *
 *  `authenticated_remote` is already bound: the pairing credential authenticates
 *  one specific runtime, and a different runtime cannot present it. A declared
 *  `expectRuntimeId` is still verified; a local filesystem path is meaningless
 *  across hosts and is never sent.
 *
 *  Absent means in-process — the caller is holding the runtime object, so there
 *  is no target to confuse. */
export type RuntimeTargetBinding = 'local_socket' | 'authenticated_remote'

/** The verbs that create or consume certification authority. Over the local
 *  socket, a request for one of these with no target stamp is refused: these are
 *  exactly the calls whose landing on the wrong runtime produced the incident. */
export const TARGET_BOUND_METHODS: ReadonlySet<string> = new Set([
  ...ORCHESTRATION_MUTATION_METHODS,
  'orchestration.validationLease',
  'orchestration.gatePlan',
  'orchestration.phaseLaunch'
])

/** Compare state roots by resolved path: a symlinked or differently spelled
 *  path to one directory is one runtime, and must not read as two. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The state root THIS runtime is actually serving.
 *
 *  Prefer the root the transport was constructed with. The process-global
 *  `AppEnvironment` is only a fallback: a single process can legitimately host a
 *  runtime scoped to a different directory than the environment installed in it,
 *  and answering "which runtime am I" from the global there refuses every
 *  correctly-addressed request. */
function runtimeUserDataPath(hostUserDataPath?: string): string | null {
  if (hostUserDataPath) {
    return canonical(hostUserDataPath)
  }
  try {
    return canonical(getAppEnvironment().getPath('userData'))
  } catch {
    return null
  }
}

/** Reads the RAW request params: schema parsing strips fields the method does
 *  not declare, and this must hold for every method rather than be added to each
 *  one's schema. */
function declaredTarget(params: unknown): {
  userDataPath?: string
  runtimeId?: string
  buildId?: string
} {
  if (!params || typeof params !== 'object') {
    return {}
  }
  const raw = params as Record<string, unknown>
  const read = (key: string): string | undefined =>
    typeof raw[key] === 'string' && (raw[key] as string).length > 0
      ? (raw[key] as string)
      : undefined
  return {
    ...(read('expectUserDataPath') ? { userDataPath: read('expectUserDataPath') } : {}),
    ...(read('expectRuntimeId') ? { runtimeId: read('expectRuntimeId') } : {}),
    ...(read('expectBuildId') ? { buildId: read('expectBuildId') } : {})
  }
}

export function assertExpectedRuntimeTarget(
  runtime: OrcaRuntimeService,
  method: string,
  params: unknown,
  transport?: RuntimeTargetBinding,
  hostUserDataPath?: string
): void {
  const expected = declaredTarget(params)
  const bound = transport === 'local_socket' && isOrchestrationMutation(method, params)
  if (!bound && !expected.userDataPath && !expected.runtimeId && !expected.buildId) {
    return
  }
  const actualUserDataPath = runtimeUserDataPath(hostUserDataPath)
  if (bound && !expected.userDataPath) {
    throw new RuntimeTargetMismatch(
      `${method} must name the Orca state root it is aimed at over the local socket. This client sent none, so the runtime it reached cannot be verified before it mutates anything.`,
      { method, expected, actual: { userDataPath: actualUserDataPath } }
    )
  }
  if (expected.userDataPath && !actualUserDataPath) {
    // Cannot establish our own state root, so we cannot prove we are the target.
    // "Could not check" must never read as "matched".
    throw new RuntimeTargetMismatch(
      `${method} names a state root, but this runtime cannot read its own, so the target cannot be verified.`,
      { method, expected, actual: { userDataPath: null } }
    )
  }
  const actualRuntimeId = runtime.getStatus().runtimeId
  const actualBuildId = runtime.getBuildIdentity().id
  const mismatch =
    (expected.userDataPath && canonical(expected.userDataPath) !== actualUserDataPath) ||
    (expected.runtimeId && expected.runtimeId !== actualRuntimeId) ||
    (expected.buildId && expected.buildId !== actualBuildId)
  if (mismatch) {
    throw new RuntimeTargetMismatch(
      `${method} was aimed at a different Orca runtime than the one that received it; refusing before it mutates anything.`,
      {
        method,
        expected,
        actual: {
          userDataPath: actualUserDataPath,
          runtimeId: actualRuntimeId,
          buildId: actualBuildId
        }
      }
    )
  }
}
