import { afterEach, describe, expect, it } from 'vitest'
import { installBrowserPasskeyRequestWatch } from './browser-passkey-request-watch'

// Like Chromium with no authenticator: the request waits until its signal aborts.
function waitForAbort(signal?: AbortSignal | null): Promise<Credential | null> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason))
  })
}

class PendingCredentialsContainer {
  static asked = 0
  get(options?: CredentialRequestOptions): Promise<Credential | null> {
    PendingCredentialsContainer.asked += 1
    return waitForAbort(options?.signal)
  }
  create(options?: CredentialCreationOptions): Promise<Credential | null> {
    return waitForAbort(options?.signal)
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'CredentialsContainer')

function install(mayAskSystem: () => boolean = () => true): {
  credentials: PendingCredentialsContainer
  reports: boolean[]
  cancel: () => void
} {
  Object.defineProperty(globalThis, 'CredentialsContainer', {
    configurable: true,
    value: PendingCredentialsContainer
  })
  const reports: boolean[] = []
  PendingCredentialsContainer.asked = 0
  const cancel = installBrowserPasskeyRequestWatch((pending) => reports.push(pending), mayAskSystem)
  return { credentials: new PendingCredentialsContainer(), reports, cancel }
}

const publicKey = { challenge: new Uint8Array(32) }

afterEach(() => {
  if (original) {
    Object.defineProperty(globalThis, 'CredentialsContainer', original)
  } else {
    Reflect.deleteProperty(globalThis, 'CredentialsContainer')
  }
})

describe('installBrowserPasskeyRequestWatch', () => {
  it('reports a pending passkey request and cancels it as the user would', async () => {
    const { credentials, reports, cancel } = install()
    const request = credentials.get({ publicKey })
    expect(reports).toEqual([true])

    cancel()
    await expect(request).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(reports).toEqual([true, false])
  })

  it("keeps the page's own abort signal working", async () => {
    const { credentials, reports } = install()
    const page = new AbortController()
    const request = credentials.get({ publicKey, signal: page.signal })
    page.abort(new DOMException('page gave up', 'AbortError'))
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(reports).toEqual([true, false])
  })

  it("holds a request main keeps from the system dialog until it is cancelled or the user's own request replaces it", async () => {
    let mayAskSystem = false
    const { credentials, reports, cancel } = install(() => mayAskSystem)
    const cancelled = credentials.get({ publicKey })
    expect(PendingCredentialsContainer.asked).toBe(0)
    expect(reports).toEqual([true])
    cancel()
    await expect(cancelled).rejects.toMatchObject({ name: 'NotAllowedError' })

    const replaced = credentials.get({ publicKey })
    mayAskSystem = true
    void credentials.get({ publicKey }).catch(() => {})
    await expect(replaced).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(PendingCredentialsContainer.asked).toBe(1)
    cancel()
  })
})
