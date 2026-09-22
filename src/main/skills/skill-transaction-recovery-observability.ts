import { startSkillPhaseOperation } from './skill-operation-observability'

export async function settleObservedSkillTransactionRecovery(input: {
  rollback: boolean
  recover(): Promise<void>
}): Promise<void> {
  const operation = startSkillPhaseOperation({ phase: 'recovery', destination: 'transaction' })
  try {
    await input.recover()
    operation.complete({
      status: 'complete',
      recoveredCount: 1,
      rollbackCount: input.rollback ? 1 : 0
    })
  } catch (error) {
    operation.fail(error)
  }
}
