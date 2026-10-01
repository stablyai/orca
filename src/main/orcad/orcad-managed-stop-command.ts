/**
 * `orcad --complete-managed-stop <request-json>`: one stop, one JSON verdict line on stdout.
 * `orcad --cancel-managed-stop <request-json>`: one cancellation, one JSON outcome line.
 *
 * Exit 0 means a result was printed — read it, the exit code does not carry it. 64 is a
 * malformed invocation; 1 is a failure before any result, which is never evidence of exit.
 */
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  ORCAD_COMPLETE_MANAGED_STOP_FLAG,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopCancellation,
  type OrcadManagedStopCompletion,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { cancelOrcadManagedStop } from './orcad-managed-stop-cancellation'
import { readOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { ZodError } from 'zod'
import {
  completeOrcadManagedStop,
  type OrcadManagedStopCompletionOptions
} from './orcad-managed-stop-completion'

export async function runOrcadManagedStopCommand(
  argv: readonly string[],
  options: OrcadManagedStopCompletionOptions = {}
): Promise<OrcadManagedStopCompletion> {
  const request = parseRequestArgument(argv, ORCAD_COMPLETE_MANAGED_STOP_FLAG)
  const verdict = await completeOrcadManagedStop(request, options)
  const retirement =
    verdict === 'exited' && request.retireIdleDaemon
      ? readOrcadCompletedStopReceipt(request)?.retirement
      : undefined
  const completion: OrcadManagedStopCompletion = {
    ...request,
    kind: 'orcad_managed_stop_completion',
    verdict,
    receiptPersisted: verdict === 'exited',
    ...(retirement ? { retirement } : {})
  }
  process.stdout.write(`${JSON.stringify(completion)}\n`)
  return completion
}

export function runOrcadManagedStopCancelCommand(
  argv: readonly string[]
): OrcadManagedStopCancellation {
  const request = parseRequestArgument(argv, ORCAD_CANCEL_MANAGED_STOP_FLAG)
  const cancellation: OrcadManagedStopCancellation = {
    ...request,
    kind: 'orcad_managed_stop_cancellation',
    outcome: cancelOrcadManagedStop(request)
  }
  process.stdout.write(`${JSON.stringify(cancellation)}\n`)
  return cancellation
}

function parseRequestArgument(argv: readonly string[], flag: string): OrcadManagedStopRequest {
  if (argv.length !== 2 || argv[0] !== flag || !argv[1]) {
    throw new Error('orcad_managed_stop_invalid_arguments')
  }
  return OrcadManagedStopRequestSchema.parse(JSON.parse(argv[1]))
}

export const ORCAD_MANAGED_STOP_EXIT_VERDICT = 0
export const ORCAD_MANAGED_STOP_EXIT_FAILED = 1
export const ORCAD_MANAGED_STOP_EXIT_USAGE = 64

export async function runOrcadManagedStopCommandAndExit(argv: readonly string[]): Promise<void> {
  let code = ORCAD_MANAGED_STOP_EXIT_VERDICT
  try {
    if (argv[0] === ORCAD_CANCEL_MANAGED_STOP_FLAG) {
      runOrcadManagedStopCancelCommand(argv)
    } else {
      await runOrcadManagedStopCommand(argv)
    }
  } catch (error) {
    console.error('orcad: managed stop failed:', error)
    code =
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === 'orcad_managed_stop_invalid_arguments')
        ? ORCAD_MANAGED_STOP_EXIT_USAGE
        : ORCAD_MANAGED_STOP_EXIT_FAILED
  }
  // Why exit after the write drains: the caller reads stdout to EOF.
  process.stdout.write('', () => process.exit(code))
}
