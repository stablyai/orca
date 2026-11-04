/** Complete all mandatory known-committed effects before surfacing any failure. */
export function settleJournalCommit(...effects: (() => void)[]): void {
  const failures: unknown[] = []
  for (const effect of effects) {
    try {
      effect()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length) {
    throw new AggregateError(failures, 'journal committed effects failed')
  }
}

/** Epoch-sized committed effects retain ownership and ordering across finite host turns. */
export async function settleJournalCommitAsync(
  effects: Iterable<() => void | Promise<void>>
): Promise<void> {
  const failures: unknown[] = []
  let work = 0
  for (const effect of effects) {
    try {
      await effect()
    } catch (error) {
      failures.push(error)
    }
    if (++work === 128) {
      work = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length) {
    throw new AggregateError(failures, 'journal committed effects failed')
  }
}

export class JournalCommittedEffectError extends Error {
  readonly outcome = 'committed'
}

/** A subscriber exception cannot fault a successfully adopted native commit. */
export async function adoptJournalCommittedEffects(
  effects: (() => void | Promise<void>)[],
  holdNotifications: (notifications: (() => void)[] | undefined) => void,
  fault: (error: Error) => void
): Promise<void> {
  const notifications: (() => void)[] = []
  holdNotifications(notifications)
  try {
    await settleJournalCommitAsync(effects)
  } catch (error) {
    const failure = new JournalCommittedEffectError(
      'Journal committed but mandatory adoption failed',
      { cause: error }
    )
    fault(failure)
    throw failure
  } finally {
    holdNotifications(undefined)
  }
  await settleJournalCommitAsync(notifications)
}
