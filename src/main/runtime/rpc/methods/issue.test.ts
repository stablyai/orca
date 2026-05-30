import { describe, expect, it, vi } from 'vitest'
import { buildRegistry, type RpcContext } from '../core'
import { ISSUE_METHODS } from './issue'

describe('issue RPC methods', () => {
  const createIssue = vi.fn()
  const ctx = { runtime: { createIssue } as never } as RpcContext

  function findMethod(name: string) {
    const method = ISSUE_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(params: Record<string, unknown>) {
    const method = findMethod('issue.create')
    const parsed = method.params ? method.params.parse(params) : undefined
    return await method.handler(parsed, ctx)
  }

  it('registers the issue create method', () => {
    const registry = buildRegistry(ISSUE_METHODS)

    expect([...registry.keys()]).toEqual(['issue.create'])
  })

  it('passes validated create params to the runtime', async () => {
    const issue = { provider: 'github', number: 42, url: 'https://github.com/o/r/issues/42' }
    createIssue.mockResolvedValueOnce(issue)

    await expect(
      call({
        provider: 'github',
        repo: 'id:repo-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).resolves.toBe(issue)
    expect(createIssue).toHaveBeenCalledWith({
      provider: 'github',
      repo: 'id:repo-1',
      title: 'Bug',
      body: 'Steps'
    })
  })

  it('rejects invalid providers and missing titles or bodies', () => {
    const method = findMethod('issue.create')

    expect(() => method.params!.parse({ provider: 'jira', title: 'Bug' })).toThrow()
    expect(() =>
      method.params!.parse({ provider: 'github', repo: 'id:repo-1', body: 'Steps' })
    ).toThrow()
    expect(() =>
      method.params!.parse({ provider: 'github', repo: 'id:repo-1', title: 'Bug' })
    ).toThrow()
  })

  it('rejects missing or mismatched provider targets', () => {
    const method = findMethod('issue.create')

    expect(() =>
      method.params!.parse({ provider: 'github', title: 'Bug', body: 'Steps' })
    ).toThrow()
    expect(() =>
      method.params!.parse({ provider: 'linear', title: 'Bug', body: 'Steps' })
    ).toThrow()
    expect(() =>
      method.params!.parse({
        provider: 'github',
        repo: 'id:repo-1',
        team: 'team-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).toThrow()
    expect(() =>
      method.params!.parse({
        provider: 'linear',
        repo: 'id:repo-1',
        team: 'team-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).toThrow()
  })
})
