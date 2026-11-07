/** This prompt's turn in a PTY's generation-scoped input queue. Aborting while queued gives up the
 *  turn at once, holding nothing; later prompts still wait for the ones before it. */
export function acquireQueueTurn(
  tails: Map<string, Promise<void>>,
  key: string,
  signal?: AbortSignal
): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => turn)
  tails.set(key, tail)
  void tail.then(() => tails.get(key) === tail && tails.delete(key))
  return new Promise((resolve, reject) => {
    const giveUp = (): void => {
      release()
      reject(new Error('request_aborted'))
    }
    if (signal?.aborted) {
      return giveUp()
    }
    signal?.addEventListener('abort', giveUp, { once: true })
    void previous.then(() => {
      if (!signal?.aborted) {
        signal?.removeEventListener('abort', giveUp)
        resolve(release)
      }
    })
  })
}
