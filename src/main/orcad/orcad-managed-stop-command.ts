// Exit 0 means JSON was printed; read its outcome. Exit 64 is invalid input, 1 is failure without exit proof.
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  ORCAD_COMPLETE_MANAGED_STOP_FLAG,
  ORCAD_MANAGED_STOP_REQUEST_FILE_FLAG,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopCancellation,
  type OrcadManagedStopCompletion,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { cancelOrcadManagedStop } from './orcad-managed-stop-cancellation'
import { readOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { readOrcadManagedStopRequest } from './orcad-managed-stop-request'
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
  if (argv[0] !== flag) {
    throw new Error('orcad_managed_stop_invalid_arguments')
  }
  if (argv[1] === ORCAD_MANAGED_STOP_REQUEST_FILE_FLAG) {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('orcad_managed_stop_invalid_arguments')
    }
    return readOrcadManagedStopRequest(argv[2])
  }
  if (argv.length !== 2 || !argv[1]) {
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
  // Drain stdout before exit: callers read the result to EOF.
  process.stdout.write('', () => process.exit(code))
}
