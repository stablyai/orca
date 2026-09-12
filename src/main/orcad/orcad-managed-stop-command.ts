import { OrcadManagedStopRequestSchema } from '../../shared/orcad-managed-stop-request'
import { completeOrcadManagedStop } from './orcad-managed-stop-completion'

export async function runOrcadManagedStopCommand(argv: string[]): Promise<void> {
  if (argv.length !== 3 || argv[0] !== '--complete-managed-stop' || !argv[2]) {
    throw new Error('orcad_managed_stop_invalid_arguments')
  }
  const request = OrcadManagedStopRequestSchema.parse(JSON.parse(argv[1]!))
  const verdict = await completeOrcadManagedStop(request, argv[2])
  process.stdout.write(
    `${JSON.stringify({
      ...request,
      kind: 'orcad_managed_stop_completion',
      receiptPersisted: verdict === 'exited',
      verdict
    })}\n`
  )
}
