import { expect, it, vi } from 'vitest'
import { PREPARE_CAPTURED_PTY_DESTINATION_METHOD as method } from './pty-captured-destination'
import { CAPTURED_PTY_DESTINATION_CAPABILITIES_METHOD as capabilities } from './pty-captured-destination'
import { terminalLayoutAdmissionFixture } from '../../../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadTerminalLayoutAdmission } from '../../../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { preparation } from '../../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { ALL_RPC_METHODS } from './index'
import type { RpcContext } from '../core'
import {
  identity,
  request as sourceProof
} from '../../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function fixture() {
  const supportsCapturedCatalogPublication = vi.fn(() => false)
  const prepareCapturedPtyDestination = vi.fn(async () => ({
    snapshot: { identity },
    importReceipt: { receipt: 'import' },
    publicationReceipt: { receipt: 'publication' },
    adapter: { secret: 'must-not-leak' },
    outputOutbox: { secret: 'must-not-leak' }
  }))
  const context: RpcContext = {
    runtime: { prepareCapturedPtyDestination, supportsCapturedCatalogPublication } as never,
    clientKind: 'runtime',
    pairedDeviceId: 'device',
    connectionId: 'socket',
    signal: new AbortController().signal
  }
  const input = {
    version: 1,
    identity,
    source: {
      version: 1,
      proof: { ...identity, version: 1, credential: sourceProof().credential },
      endpoint: '/source.sock',
      incumbentVersion: 'build',
      endpointCredential: 'source-secret'
    },
    model: {
      version: 1,
      identity,
      throughSeq: 1,
      modelSequenceEnd: 100,
      modelData: 'preserved',
      cols: 80,
      rows: 24,
      restoreMetadata: { version: 1 }
    }
  }
  const call = (value: unknown = input, ctx = context) =>
    Promise.resolve().then(() => method.handler(method.params!.parse(value), ctx))
  return { prepareCapturedPtyDestination, supportsCapturedCatalogPublication, context, input, call }
}

it.each([undefined, false, true])(
  'advertises applied output coverage only with explicit support: %s',
  (supported) => {
    const f = fixture()
    if (supported !== undefined) {
      f.context.runtime.supportsCapturedCatalogOutputCoverage = () => supported
    }
    const result = capabilities.handler({ version: 1 }, f.context)
    if (supported) {
      expect(result).toHaveProperty('catalogOutputCoverage', 1)
    } else {
      expect(result).not.toHaveProperty('catalogOutputCoverage')
    }
  }
)

it.each([undefined, false, true])(
  'advertises recovery only with explicit runtime support: %s',
  (supported) => {
    const f = fixture()
    if (supported !== undefined) {
      f.context.runtime.supportsCapturedSourceRetirementRecovery = () => supported
    }
    const result = capabilities.handler({ version: 1 }, f.context)
    if (supported) {
      expect(result).toHaveProperty('sourceRetirementRecovery', 1)
    } else {
      expect(result).not.toHaveProperty('sourceRetirementRecovery')
    }
  }
)

it.each([false, true])(
  'advertises optional retirement support only when enabled: %s',
  (supported) => {
    const f = fixture()
    f.context.runtime.supportsCapturedSourceRetirement = () => supported
    const result = capabilities.handler({ version: 1 }, f.context)
    if (supported) {
      expect(result).toMatchObject({ sourceRetirement: 1 })
    } else {
      expect(result).not.toHaveProperty('sourceRetirement')
    }
  }
)

it('registers the additive capture method once and returns publication evidence only', async () => {
  const f = fixture()
  expect(ALL_RPC_METHODS.filter((entry) => entry.name === method.name)).toHaveLength(1)
  expect(await f.call()).toEqual({
    version: 1,
    outcome: 'published',
    identity,
    importReceipt: { receipt: 'import' },
    publicationReceipt: { receipt: 'publication' }
  })
  expect(f.prepareCapturedPtyDestination).toHaveBeenCalledExactlyOnceWith({
    identity: f.input.identity,
    source: f.input.source,
    model: f.input.model,
    signal: f.context.signal
  })
})

it.each([
  { clientKind: 'mobile' as const },
  { pairedDeviceId: undefined },
  { connectionId: undefined },
  { signal: undefined },
  { signal: AbortSignal.abort() }
])('refuses invalid caller context %j before runtime mutation', async (overrides) => {
  const f = fixture()
  await expect(f.call(f.input, { ...f.context, ...overrides })).rejects.toThrow()
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
})

it.each(['version', 'timeout', 'model', 'identity', 'source'] as const)(
  'validates %s before invoking the runtime',
  async (field) => {
    const f = fixture()
    const changes = {
      version: { version: 2 },
      timeout: { timeoutMs: 60_001 },
      model: { model: { ...f.input.model, modelData: 5 } },
      identity: { identity: { ...identity, sourceOwnerGeneration: 0 } },
      source: { source: { ...f.input.source, endpointCredential: '' } }
    }
    await expect(f.call({ ...f.input, ...changes[field] })).rejects.toThrow()
    expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
  }
)

it('propagates runtime gate and pending refusals without inventing publication success', async () => {
  const f = fixture()
  const error = new Error('pty_ownership_transfer_production_disabled')
  f.prepareCapturedPtyDestination.mockRejectedValueOnce(error)
  await expect(f.call()).rejects.toBe(error)
})

it.each([null, {}, { version: 1 }, false])(
  'refuses catalog requirements on the legacy request before mutation (%j)',
  async (catalogAdmission) => {
    const f = fixture()
    await expect(f.call({ ...f.input, catalogAdmission })).rejects.toThrow()
    expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
  }
)

it('advertises handle-bound session terminal identity for migration admission', async () => {
  const f = fixture()
  expect(await capabilities.handler({ version: 1 }, f.context)).toHaveProperty(
    'sessionTerminalIdentity',
    1
  )
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
})

it('retains ordinary unknown-field compatibility for legacy requests', async () => {
  const f = fixture()
  await expect(f.call({ ...f.input, futureOptionalMetadata: 'ignored' })).resolves.toMatchObject({
    outcome: 'published'
  })
  expect(f.prepareCapturedPtyDestination).toHaveBeenCalledOnce()
})

it('reports current host support without invoking preparation', async () => {
  const f = fixture()
  expect(ALL_RPC_METHODS.filter((entry) => entry.name === capabilities.name)).toHaveLength(1)
  expect(await capabilities.handler({ version: 1 }, f.context)).toEqual({
    version: 1,
    sessionTerminalIdentity: 1,
    catalogPublication: null
  })
  f.supportsCapturedCatalogPublication.mockReturnValue(true)
  expect(await capabilities.handler({ version: 1 }, f.context)).toEqual({
    version: 1,
    sessionTerminalIdentity: 1,
    catalogPublication: 1
  })
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
})

it('advertises the catalog transaction only when every required runtime method is available', async () => {
  const methods = {
    stageOrcadMigrationCatalog: 'orcad.migration.stageCatalog',
    commitStagedOrcadMigrationCatalog: 'orcad.migration.commitCatalog',
    stageOrcadMigrationSnapshotChunk: 'orcad.migration.stageSnapshotChunk',
    abortStagedOrcadMigrationCatalog: 'orcad.migration.abortCatalog',
    getOrcadMigrationCatalogState: 'orcad.migration.catalogState'
  } as const
  const f = fixture()
  const implementations = Object.fromEntries(Object.keys(methods).map((key) => [key, vi.fn()]))
  Object.assign(f.context.runtime, implementations)
  expect(await capabilities.handler({ version: 1 }, f.context)).toHaveProperty(
    'catalogMigrationVersion',
    1
  )
  for (const [key, rpc] of Object.entries(methods)) {
    expect(ALL_RPC_METHODS.filter((method) => method.name === rpc)).toHaveLength(1)
    Object.assign(f.context.runtime, { [key]: undefined })
    expect(await capabilities.handler({ version: 1 }, f.context)).not.toHaveProperty(
      'catalogMigrationVersion'
    )
    Object.assign(f.context.runtime, { [key]: implementations[key] })
  }
  for (const method of Object.values(implementations)) {
    expect(method).not.toHaveBeenCalled()
  }
})

it.each([
  { clientKind: 'mobile' as const },
  { pairedDeviceId: undefined },
  { connectionId: undefined },
  { signal: undefined },
  { signal: AbortSignal.abort() }
])('refuses unauthorized or stopped capability discovery %j', async (overrides) => {
  const f = fixture()
  await expect(
    Promise.resolve().then(() =>
      capabilities.handler({ version: 1 }, { ...f.context, ...overrides })
    )
  ).rejects.toThrow()
  expect(f.supportsCapturedCatalogPublication).not.toHaveBeenCalled()
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
})

it('requires catalog-bearing version 2 and rechecks host support at mutation', async () => {
  const f = fixture()
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const catalogAdmission = parseOrcadTerminalLayoutAdmission({
    version: 1,
    manifest,
    bindings: [{ identity, surfaceBinding: preparation.surfacePublication.surfaceBinding }]
  })
  const input = { ...f.input, version: 2, catalogAdmission }
  await expect(f.call(input)).rejects.toThrow('catalog_unavailable')
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
  f.supportsCapturedCatalogPublication.mockReturnValue(true)
  expect(await f.call(input)).toMatchObject({
    version: 2,
    catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
  })
  expect(f.prepareCapturedPtyDestination).toHaveBeenCalledWith(
    expect.objectContaining({ catalogAdmission })
  )
  f.prepareCapturedPtyDestination.mockClear()
  f.supportsCapturedCatalogPublication.mockReturnValue(false)
  await expect(f.call(input)).rejects.toThrow('catalog_unavailable')
  expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
})

it.each([{}, { version: 2 }, { version: 2, catalogAdmission: null }])(
  'refuses incomplete version 2 request %j',
  async (change) => {
    const f = fixture()
    await expect(f.call({ ...f.input, version: 2, ...change })).rejects.toThrow()
    expect(f.prepareCapturedPtyDestination).not.toHaveBeenCalled()
  }
)
