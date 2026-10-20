import type {
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptPreview
} from '../../shared/repository-add-script-types'

const MAX_OUTPUT_CHARACTERS = 16_384

// A running or unverifiable script may still be alive, so its intent and registration are kept.
export function isUnsettledOutcome(outcome: RepositoryAddScriptOutcome | undefined): boolean {
  return outcome?.status === 'running' || outcome?.status === 'unverifiable'
}

// An aborted run never succeeded, whatever exit the process reported.
export function settledOutcome(
  result: RepositoryAddScriptExecutionResult,
  aborted: boolean
): RepositoryAddScriptOutcome {
  const output = result.output.slice(0, MAX_OUTPUT_CHARACTERS)
  const outputTruncated =
    result.outputTruncated === true || result.output.length > MAX_OUTPUT_CHARACTERS
  if (result.processVerdict === 'unverifiable') {
    return { status: 'unverifiable', output, outputTruncated }
  }
  const exitCode = aborted ? undefined : result.exitCode
  return {
    status: exitCode === 0 ? 'succeeded' : 'failed',
    ...(exitCode === undefined ? {} : { exitCode }),
    output,
    outputTruncated
  }
}

// Only the alias and repo the token was issued to may read it; anything else sees no outcome.
export function ownedOutcome(
  intent: { preview: RepositoryAddScriptPreview; outcome: RepositoryAddScriptOutcome } | undefined,
  identity: RepositoryAddScriptIdentity | null | undefined
): RepositoryAddScriptOutcome | null {
  if (
    !intent ||
    intent.preview.token !== identity?.token ||
    intent.preview.hostId !== identity.hostId ||
    intent.preview.repoId !== identity.repoId
  ) {
    return null
  }
  return { ...intent.outcome }
}
