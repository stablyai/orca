import { describe, expect, it } from 'vitest'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import { setupAcpSession } from './acp-session-setup'

function makeInitialized(
  sessionCapabilities?: NonNullable<InitializeResponse['agentCapabilities']>['sessionCapabilities']
): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities
    }
  }
}

describe('setupAcpSession additionalDirectories capability gate', () => {
  it('forwards additionalDirectories on session/new, session/load, and session/resume when advertised', async () => {
    const calls: { method: string; params: unknown }[] = []
    const request = async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params })
      return { sessionId: 'sess-1' } as T
    }
    const initialized = makeInitialized({
      additionalDirectories: {},
      resume: {}
    })

    await setupAcpSession(
      initialized,
      { cwd: '/repo', mcpServers: [], additionalDirectories: ['/extra/a', '/extra/b'] },
      request
    )
    await setupAcpSession(
      initialized,
      {
        cwd: '/repo',
        mcpServers: [],
        sessionId: 'sess-1',
        additionalDirectories: ['/extra/a', '/extra/b']
      },
      request
    )
    await setupAcpSession(
      initialized,
      {
        cwd: '/repo',
        mcpServers: [],
        sessionId: 'sess-1',
        resumePreference: 'resume',
        additionalDirectories: ['/extra/a', '/extra/b']
      },
      request
    )

    expect(calls).toEqual([
      {
        method: 'session/new',
        params: { cwd: '/repo', mcpServers: [], additionalDirectories: ['/extra/a', '/extra/b'] }
      },
      {
        method: 'session/load',
        params: {
          cwd: '/repo',
          mcpServers: [],
          sessionId: 'sess-1',
          additionalDirectories: ['/extra/a', '/extra/b']
        }
      },
      {
        method: 'session/resume',
        params: {
          cwd: '/repo',
          mcpServers: [],
          sessionId: 'sess-1',
          additionalDirectories: ['/extra/a', '/extra/b']
        }
      }
    ])
  })

  it('omits additionalDirectories on session/new, session/load, and session/resume when not advertised', async () => {
    const calls: { method: string; params: unknown }[] = []
    const request = async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params })
      return { sessionId: 'sess-1' } as T
    }
    const initialized = makeInitialized({
      resume: {}
    })

    await setupAcpSession(
      initialized,
      { cwd: '/repo', mcpServers: [], additionalDirectories: ['/extra/a'] },
      request
    )
    await setupAcpSession(
      initialized,
      {
        cwd: '/repo',
        mcpServers: [],
        sessionId: 'sess-1',
        additionalDirectories: ['/extra/a']
      },
      request
    )
    await setupAcpSession(
      initialized,
      {
        cwd: '/repo',
        mcpServers: [],
        sessionId: 'sess-1',
        resumePreference: 'resume',
        additionalDirectories: ['/extra/a']
      },
      request
    )

    expect(calls).toEqual([
      {
        method: 'session/new',
        params: { cwd: '/repo', mcpServers: [] }
      },
      {
        method: 'session/load',
        params: { cwd: '/repo', mcpServers: [], sessionId: 'sess-1' }
      },
      {
        method: 'session/resume',
        params: { cwd: '/repo', mcpServers: [], sessionId: 'sess-1' }
      }
    ])
  })
})
