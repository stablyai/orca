import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
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
vi.mock('../../shared/remote-runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeRequest: subscribeMock
}))
vi.mock('./runtime-environment-shared-control-support', async (importOriginal) => ({
  ...(await importOriginal()),
  supportsSharedControl: supportsMock
}))

import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
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
  it('keeps verifying status after the store stops resolving the environment', () => {
    const environment = seedEnvironment()
    const transport = {
      isReady: () => false,
      request: vi.fn(),
      establish: vi.fn(),
      pause: vi.fn()
    }
    const owner = createRuntimeEnvironmentStatusOwner(userDataPath, environment, transport)
    removeEnvironment(userDataPath, environment.id)

    // A throw here escapes `void verify()` as an unhandled rejection and skips settleWaiters(),
    // hanging every refresh() caller until its own 15s timeout.
    expect(() => owner.acceptVerified(statusResponse())).not.toThrow()
    // Teardown for a removed environment belongs to the removal watcher, not to a status reader.
    expect(transport.establish).toHaveBeenCalledOnce()
    owner.dispose()
  })

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
    // Any store failure is fatal on this path, not just a removal: a half-written or
    // ACL-hardened settings file reaches the same unguarded socket callback.
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

function statusResponse() {
  return {
    id: 'status.get',
    ok: true as const,
    result: {
      runtimeId: 'r',
      rendererGraphEpoch: 1,
      graphStatus: 'ready' as const,
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
    },
    _meta: { runtimeId: 'r' }
  }
}

async function subscribed(method: string) {
  const environment = seedEnvironment()
  supportsMock.mockResolvedValue(absentOutcome(environment))
  let callbacks: ResponseCallbacks | null = null
  subscribeMock.mockImplementation(
    async (_pairing, _method, _params, _timeoutMs, received: ResponseCallbacks) => {
      callbacks = received
      return { close: () => {} } satisfies Partial<RemoteRuntimeSubscription>
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
    getPreferredPairingOffer(environment)
  )
  applyRuntimeEnvironmentCapabilityVerdict({
    evidence,
    verdict: 'absent',
    runtimeId: 'r'
  })
  return runtimeEnvironmentCapabilityOutcome(evidence, 'absent', 'r')
}
