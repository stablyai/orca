import { describe, expect, it, vi } from 'vitest'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { getRemoteLinearHelp } from './ssh-remote-linear-cli'
import { tryDispatchRemoteLinearReadCli } from './ssh-remote-linear-read-cli'

function dispatcher() {
  const dispatch = vi.fn().mockResolvedValue({ id: 'request', ok: true, result: {} })
  return { dispatch, value: { dispatch } as unknown as RpcDispatcher }
}

describe('SSH Linear pagination contract', () => {
  it('keeps omitted list limits omitted', async () => {
    const target = dispatcher()

    await tryDispatchRemoteLinearReadCli(target.value, parseRemoteCliArgs(['linear', 'list']), {})
    await tryDispatchRemoteLinearReadCli(
      target.value,
      parseRemoteCliArgs(['linear', 'project', 'list']),
      {}
    )

    expect(target.dispatch.mock.calls[0][0]).toMatchObject({
      method: 'linear.agentIssueList',
      params: {
        filter: undefined,
        teamInput: undefined,
        limit: undefined,
        workspaceId: undefined
      }
    })
    expect(target.dispatch.mock.calls[1][0]).toMatchObject({
      method: 'linear.agentProjectList',
      params: { query: undefined, limit: undefined, workspaceId: undefined }
    })
  })

  it('documents omitted-limit exhaustion in SSH help', () => {
    const projectHelp = getRemoteLinearHelp(
      parseRemoteCliArgs(['linear', 'project', 'list', '--help'])
    )
    const issueHelp = getRemoteLinearHelp(parseRemoteCliArgs(['linear', 'list', '--help']))

    expect(projectHelp).toContain('Omit --limit to walk until exhaustion or a safety backstop')
    expect(issueHelp).toContain('Omit --limit to walk until exhaustion or a safety backstop')
  })

  // Why: the same command must not describe a different contract depending on the execution host.
  it('matches the local command summaries in the remote linear listing', () => {
    const groupHelp = getRemoteLinearHelp(parseRemoteCliArgs(['linear', '--help']))

    expect(groupHelp).toContain('List Linear projects; omit --limit to walk until exhaustion')
    expect(groupHelp).toContain('List Linear issues; omit --limit to walk until exhaustion')
    expect(groupHelp).not.toContain('List connected Linear projects')
  })
})
