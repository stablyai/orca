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
})
