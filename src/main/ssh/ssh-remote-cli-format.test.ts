import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../runtime/rpc/core'
import { formatRemoteCli } from './ssh-remote-cli-format'

const meta = { runtimeId: 'runtime-test' }

describe('formatRemoteCli', () => {
  it('falls back to JSON for malformed Linear issue results', () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      _meta: meta,
      result: {
        issue: {
          identifier: 'ENG-123',
          title: 'Fix thing',
          url: 'https://linear.app/acme/issue/ENG-123',
          labels: []
        },
        meta: {
          includeErrors: null,
          sections: {}
        }
      }
    }

    expect(formatRemoteCli(response)).toEqual({
      stdout: `${JSON.stringify(response.result)}\n`,
      stderr: ''
    })
  })

  it('falls back to JSON for malformed Linear search results', () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      _meta: meta,
      result: {
        issues: [],
        meta: {
          query: 'auth',
          returned: '0'
        }
      }
    }

    expect(formatRemoteCli(response)).toEqual({
      stdout: `${JSON.stringify(response.result)}\n`,
      stderr: ''
    })
  })

  it('falls back to JSON for malformed Linear list-issues metadata', () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      _meta: meta,
      result: {
        issues: [],
        meta: {
          limit: null,
          returned: 0,
          orderBy: 'updatedAt',
          partial: false,
          workspaceErrors: []
        }
      }
    }

    expect(formatRemoteCli(response)).toEqual({
      stdout: `${JSON.stringify(response.result)}\n`,
      stderr: ''
    })
  })

  it('falls back to JSON for malformed Linear list-issues rows', () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      _meta: meta,
      result: {
        issues: [{}],
        meta: {
          limit: null,
          returned: 1,
          hasMore: false,
          orderBy: 'updatedAt',
          partial: false,
          workspaceErrors: []
        }
      }
    }

    expect(formatRemoteCli(response)).toEqual({
      stdout: `${JSON.stringify(response.result)}\n`,
      stderr: ''
    })
  })

  it('falls back to JSON for malformed Linear issue row fields', () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      _meta: meta,
      result: {
        issues: [
          {
            id: 'issue-1',
            identifier: 'ENG-1',
            title: 'Broken state',
            url: 'https://linear.app/acme/issue/ENG-1',
            labels: [],
            state: { name: 42 },
            workspace: { id: 'workspace-1', name: 'Acme' }
          }
        ],
        meta: {
          limit: null,
          returned: 1,
          hasMore: false,
          orderBy: 'updatedAt',
          partial: false,
          workspaceErrors: []
        }
      }
    }

    expect(formatRemoteCli(response)).toEqual({
      stdout: `${JSON.stringify(response.result)}\n`,
      stderr: ''
    })
  })
})
