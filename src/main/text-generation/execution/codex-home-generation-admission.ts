import { codexHomeProcessLockBusy } from '../../codex-cli/codex-home-process-lock'
import type { GenerationAdmission } from './background-generation-slots'
import { CANCELED_GENERATION_RESULT } from './source-control-generation-lanes'
import type {
  InternalTextGenerationResult,
  LocalProcessExecution
} from '../source-control-text-generation-types'

type GenerationExecution = LocalProcessExecution<InternalTextGenerationResult>

/** Background runs for one Codex home take turns, so only the front one retries admission. */
const turnsByHome = new Map<string, Promise<void>>()

/**
 * Takes a background slot and the Codex home lock together, never holding one while waiting for
 * the other: a run that finds the account busy gives its slot back, waits for the account, then
 * returns to the front of the slot queue.
 */
export async function admitUnderFreeCodexHome(
  admit: GenerationAdmission,
  lockKey: string,
  startUnderLock: () => GenerationExecution
): Promise<GenerationExecution | null> {
  const prior = turnsByHome.get(lockKey) ?? Promise.resolve()
  const turn = Promise.withResolvers<void>()
  const tail = prior.then(() => turn.promise)
  turnsByHome.set(lockKey, tail)
  void tail.then(() => {
    if (turnsByHome.get(lockKey) === tail) {
      turnsByHome.delete(lockKey)
    }
  })
  await prior
  try {
    return await admitWhenHomeFree(admit, lockKey, startUnderLock)
  } finally {
    turn.resolve()
  }
}

async function admitWhenHomeFree(
  admit: GenerationAdmission,
  lockKey: string,
  startUnderLock: () => GenerationExecution
): Promise<GenerationExecution | null> {
  let returning = false
  for (;;) {
    const busy = codexHomeProcessLockBusy(lockKey)
    if (busy) {
      // Waiting here holds no slot, so it keeps its place rather than jumping the queue.
      await busy
      continue
    }
    let homeBusy = false
    const execution = await admit(
      () => {
        if (codexHomeProcessLockBusy(lockKey)) {
          homeBusy = true
          return {
            result: Promise.resolve(CANCELED_GENERATION_RESULT),
            processClosed: Promise.resolve()
          }
        }
        return startUnderLock()
      },
      { returning }
    )
    if (!homeBusy) {
      return execution
    }
    returning = true
  }
}
