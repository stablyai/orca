import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE } from '../../../ssh/targets/ssh-target-registry'
import { SSH_METHODS } from './ssh'

const target = { label: 'Build', host: 'build.internal', port: 22, username: 'ci' }

// orcad advertises target-management without SSH handlers; refuse with text released clients can display (D3).
describe('SSH target management on a host with no SSH stack', () => {
  const runtime = new OrcaRuntimeService()
  const dispatch = (method: string, params?: unknown) =>
    new RpcDispatcher({ runtime, methods: SSH_METHODS }).dispatch({
      id: 'req-1',
      authToken: 'tok',
      method,
      params
    })

  it.each([
    ['ssh.addTarget', { target }],
    ['ssh.updateTarget', { targetId: 'ssh-1', target }],
    ['ssh.removeTarget', { targetId: 'ssh-1' }],
    ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' }]
  ])('%s refuses with an accurate message', async (method, params) => {
    expect(await dispatch(method, params)).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE }
    })
  })

  it('still lists no targets rather than failing', async () => {
    expect(await dispatch('ssh.listEditableTargets')).toMatchObject({
      ok: true,
      result: { targets: [] }
    })
  })
})
