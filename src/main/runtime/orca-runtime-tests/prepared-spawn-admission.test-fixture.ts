import type { RuntimePtyController } from '../terminal/lifecycle/runtime-pty-controller-contract'

type SpawnArgs = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]

// Explicit and automatic fake adapters may wrap the same call; admission still runs only once.
const fakePreparedAdmissions = new WeakMap<Pick<SpawnArgs, 'admitPreparedSpawn'>, Promise<void>>()

export async function admitFakePreparedSpawn(
  args: Pick<SpawnArgs, 'admitPreparedSpawn'>
): Promise<void> {
  if (!args.admitPreparedSpawn) {
    return
  }
  let admission = fakePreparedAdmissions.get(args)
  if (!admission) {
    admission = args.admitPreparedSpawn()
    fakePreparedAdmissions.set(args, admission)
  }
  await admission
}
