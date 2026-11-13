import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'

import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence,
  runtimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'

type ResponseCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
}

const { subscribeMock, supportsMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  supportsMock: vi.fn()
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock(
  '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport',
  async (importOriginal) => ({
    ...(await importOriginal()),
    subscribeRemoteRuntimeTransport: subscribeMock
  })
)
vi.mock('./runtime-environment-shared-control-support', async (importOriginal) => ({
  ...(await importOriginal()),
  supportsSharedControl: supportsMock
}))

import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-removal-routing-'))
  resetRuntimeEnvironmentCapabilityEvidence()
  subscribeMock.mockReset()
  supportsMock.mockReset()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('runtime responses the app can no longer attribute to a saved server', () => {
  it.each([
    ['direct subscription', 'browser.screencast'],
    ['support-routed subscription on a host without shared control', 'files.watch']
  ])('forwards a %s response after `orca environment rm`', async (_label, method) => {
    const { deliver, onEvent, environment } = await subscribed(method)
    // Mirrors the CLI: it edits the store without telling the running app.
    removeEnvironment(userDataPath, environment.id)
    const response = {
      id: method,
      ok: true as const,
      result: {},
      _meta: { runtimeId: 'r' }
    }

    expect(() => deliver(response)).not.toThrow()
    expect(onEvent).toHaveBeenCalledWith({ type: 'response', response })
  })

  it.each([
    ['direct subscription', 'browser.screencast'],
    ['support-routed subscription on a host without shared control', 'files.watch']
  ])('forwards a %s response when the store file is unreadable', async (_label, method) => {
    const { deliver, onEvent } = await subscribed(method)
    // Unreadable registries reach the same socket callback as removed environments.
    writeFileSync(getEnvironmentStorePath(userDataPath), '{not json')
    const response = {
      id: method,
      ok: true as const,
      result: {},
      _meta: { runtimeId: 'r' }
    }

    expect(() => deliver(response)).not.toThrow()
    expect(onEvent).toHaveBeenCalledWith({ type: 'response', response })
  })
})

async function subscribed(method: string) {
  const environment = seedEnvironment()
  supportsMock.mockResolvedValue(absentOutcome(environment))
  let callbacks: ResponseCallbacks | null = null
  subscribeMock.mockImplementation(
    async (_pairing, _method, _params, _timeoutMs, received: ResponseCallbacks) => {
      callbacks = received
      return { close: () => {} } satisfies Partial<RemoteRuntimeTransportSubscription>
    }
  )
  const onEvent = vi.fn()
  await subscribeRuntimeEnvironment(userDataPath, environment.id, method, {}, 1000, {
    onEvent,
    onClose: () => {}
  })
  return {
    deliver: (response: RuntimeRpcResponse<unknown>) => callbacks?.onResponse(response),
    onEvent,
    environment
  }
}

function seedEnvironment(): KnownRuntimeEnvironment {
  return addEnvironmentFromPairingCode(userDataPath, {
    name: 'dev box',
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    })
  })
}

function absentOutcome(environment: KnownRuntimeEnvironment) {
  const evidence = captureRuntimeEnvironmentCapabilityEvidence(
    environment.id,
    pairedRuntimeConnectionFromOffer(getPreferredPairingOffer(environment))
  )
  applyRuntimeEnvironmentCapabilityVerdict({
    evidence,
    verdict: 'absent',
    runtimeId: 'r'
  })
  return runtimeEnvironmentCapabilityOutcome(evidence, 'absent', 'r')
}
