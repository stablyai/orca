import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { closeRemoteRuntimeRequestConnection } from '../ipc/runtime-environments/runtime-environment-request-connections'
import {
  createArtifactSession,
  readArtifactSession,
  releaseArtifactSession
} from '../github/client/actions/artifact-download-sessions'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

it('keeps an archive across separate paired calls and releases it on cancellation or transport disconnect', async () => {
  vi.stubEnv('ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL', '1')
  const directory = mkdtempSync(join(tmpdir(), 'orca-artifact-transport-'))
  mkdirSync(join(directory, 'host'))
  mkdirSync(join(directory, 'client'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: join(directory, 'host'),
    enableWebSocket: true,
    wsPort: 0
  })
  const archive = Buffer.from([80, 75, 3, 4, 0, 255, 128])
  const repo = 'fixture-repo'
  const transfers: string[] = []
  const start = vi
    .spyOn(runtime, 'startRepoActionsArtifactDownload')
    .mockImplementation(async (_repo, _params, signal, dispose) => {
      const transfer = createArtifactSession(repo, archive, 'fixture.zip', signal, dispose)
      transfers.push(transfer.transferId)
      return transfer
    })
  const read = vi
    .spyOn(runtime, 'readRepoActionsArtifactChunk')
    .mockImplementation(async (_repo, params) =>
      readArtifactSession(params.transferId, repo, params.offset ?? 0)
    )
  const release = vi
    .spyOn(runtime, 'releaseRepoActionsArtifactDownload')
    .mockImplementation(async (_repo, params) => releaseArtifactSession(params.transferId, repo))
  let environmentId: string | undefined
  try {
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'fixture',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('Fixture pairing unavailable')
    }
    const clientPath = join(directory, 'client')
    const environment = addEnvironmentFromPairingCode(clientPath, {
      name: 'fixture',
      pairingCode: offer.pairingUrl
    })
    environmentId = environment.id
    const call = async (method: string, params: unknown) => {
      try {
        return await callRuntimeEnvironment(clientPath, environment.id, method, params, 5_000)
      } catch (cause) {
        throw new Error(`Artifact fixture RPC failed: ${method}`, { cause })
      }
    }
    const startParams = {
      repo,
      repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
      runId: 9,
      artifactId: 7
    }
    const first = await call('github.startActionsArtifactDownload', startParams)
    expect(first).toMatchObject({ ok: true, result: { transferId: transfers[0] } })
    const chunk = await call('github.readActionsArtifactChunk', {
      repo,
      transferId: transfers[0],
      offset: 0
    })
    expect(chunk).toMatchObject({
      ok: true,
      result: { contentBase64: archive.toString('base64'), done: true }
    })
    expect(
      await call('github.releaseActionsArtifactDownload', { repo, transferId: transfers[0] })
    ).toMatchObject({ ok: true })
    expect(() => readArtifactSession(transfers[0], repo, 0)).toThrow('expired')

    expect(await call('github.startActionsArtifactDownload', startParams)).toMatchObject({
      ok: true
    })
    closeRemoteRuntimeRequestConnection(environment.id)
    await vi.waitFor(() =>
      expect(() => readArtifactSession(transfers[1], repo, 0)).toThrow('expired')
    )
  } finally {
    if (environmentId) {
      closeRemoteRuntimeRequestConnection(environmentId)
    }
    for (const transfer of transfers) {
      releaseArtifactSession(transfer, repo)
    }
    start.mockRestore()
    read.mockRestore()
    release.mockRestore()
    await server.stop()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
