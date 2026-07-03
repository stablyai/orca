import { describe, expect, it } from 'vitest'
import { getTerminalLiveAccessoryInactiveInputCommitResult } from './use-terminal-live-accessory-input-commit'

type DeferredBoolean = {
  readonly promise: Promise<boolean>
  readonly resolve: (value: boolean) => void
}

function createDeferredBoolean(): DeferredBoolean {
  let resolvePromise: (value: boolean) => void = () => {
    throw new Error('deferred promise was resolved before initialization')
  }
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('terminal live accessory input commit', () => {
  it('Given live input is disabled with an active flush When accessory raw fallback is requested Then waits before allowing raw send', async () => {
    // Given
    const deferredFlush = createDeferredBoolean()
    let settled = false

    // When
    const resultPromise = getTerminalLiveAccessoryInactiveInputCommitResult(
      () => deferredFlush.promise
    )
    void resultPromise.then(() => {
      settled = true
    })
    await Promise.resolve()

    // Then
    expect(settled).toBe(false)
    deferredFlush.resolve(true)
    await expect(resultPromise).resolves.toEqual({ kind: 'allow-raw' })
  })

  it('Given live input is disabled with a failed active flush When accessory raw fallback is requested Then suppresses raw send', async () => {
    // Given
    const waitForPendingLiveInputFlush = async (): Promise<boolean> => false

    // When
    const result = await getTerminalLiveAccessoryInactiveInputCommitResult(
      waitForPendingLiveInputFlush
    )

    // Then
    expect(result).toEqual({ kind: 'suppress-raw' })
  })
})
