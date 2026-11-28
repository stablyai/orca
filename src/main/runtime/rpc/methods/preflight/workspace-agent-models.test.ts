import { expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { harness } from '../../../../native-chat/agent-model-catalog/agent-model-catalog-account-list-test-support'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../../construction/test-context/runtime-store-partial-fixture'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { PREFLIGHT_METHODS } from './preflight'

function notes(host: ExecutionHostId, folderPath: string) {
  return storeFolderWorkspace({
    id: 'notes',
    projectGroupId: 'group',
    folderPath,
    executionHostId: host
  })
}

it('reads a mirrored folder only from its owner, even when the caller has the same folder ID', async () => {
  const folders = [notes('local', '/restricted')]
  const owner = new OrcaRuntimeService(
    partialRuntimeStore({
      getFolderWorkspaces: () => folders,
      getSettings: () => ({ agentCmdOverrides: { codex: 'node' } })
    })
  )
  const { service } = harness('codex')
  vi.spyOn(owner, 'structuredAgentModelCatalog').mockResolvedValue(service)
  const peer = new RpcDispatcher({ runtime: owner, methods: PREFLIGHT_METHODS })
  const caller = new OrcaRuntimeService(
    partialRuntimeStore({
      getFolderWorkspaces: () => [
        notes('local', '/project-a'),
        notes('runtime:peer', '/restricted')
      ]
    }),
    undefined,
    {
      orchestrationEnvironmentTransport: {
        resolve: () => ({
          environmentId: 'peer',
          name: 'Peer',
          peerFingerprint: 'peer',
          pairingRevision: 1
        }),
        call: (_server, method, params) =>
          peer.dispatch({ id: 'forwarded', authToken: 'test', method, params })
      }
    }
  )
  const dispatcher = new RpcDispatcher({ runtime: caller, methods: PREFLIGHT_METHODS })
  const read = () =>
    dispatcher.dispatch({
      id: 'models',
      authToken: 'test',
      method: 'preflight.agentModels',
      params: { agent: 'codex', worktreeId: 'folder:notes', worktreeHostId: 'runtime:peer' }
    })

  expect(await read()).toMatchObject({
    ok: true,
    result: { origin: 'probe', models: [{ id: 'local-only' }] }
  })
  folders.splice(0, 1, notes('runtime:elsewhere', '/restricted'))
  expect(await read()).toMatchObject({ ok: false, error: { code: 'selector_not_found' } })
})
