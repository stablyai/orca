import { afterEach, expect, it, vi } from 'vitest'
import { dispatch, type HandlerContext } from '../../../../../cli/dispatch/dispatch'
import { RuntimeClientError } from '../../../../../cli/runtime/connection/types'
import type { ConnectorCloudFeature } from '../../../../../shared/connector-cloud-features'
import * as htmlFences from '../../../../../shared/markdown/html-document-fences'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { CONNECTOR_METHODS } from './connector'

const HTML = '  ~~~~` \tHTML title\r\n<!doctype html>\r\n<html><body>Report</body></html>\r\n  ~~~~'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each([20, 200])(
  'skips repeat discovery for ordinary replies and unsupported clouds (%i bots)',
  async (botCount) => {
    const bots = Array.from({ length: botCount }, (_, index) => ({
      id: `bot-${index}`,
      folderWorkspaceId: `home-${index}`
    }))
    const bot = bots.at(-1)!
    const worktreeId = `folder:${bot.folderWorkspaceId}`
    let sessionWorkspaceId = worktreeId
    let linkedToBot = true
    let sessionReads = 0
    let rosterReads = 0
    const features = new Set<ConnectorCloudFeature>(['actions', 'files.direct'])
    const host = {
      deps: {
        store: {
          getConversation: () => {
            sessionReads++
            return { location: { workspaceId: sessionWorkspaceId } }
          }
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this route only reads the conversation store from the host.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
    const replyIds: string[] = []
    const stagedNames: unknown[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: {
        enabled: () => true,
        list: () => {
          rosterReads++
          return bots
        }
      },
      getExternalConversationSeam: () => ({
        replyTarget: () => ({
          key: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
          turnId: 2,
          worktreeId: sessionWorkspaceId,
          ...(linkedToBot ? { bot: { kind: 'bot', botId: bot.id } } : {})
        })
      }),
      getConnectorCloud: () => ({
        cloudFeatures: () => features,
        reply: async ({ replyId }: { replyId: string }) => {
          replyIds.push(replyId)
          return { ok: true, value: { status: 'posted' } }
        }
      })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provides the connector route's conversation and cloud seams.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: CONNECTOR_METHODS
    })
    const reply = (id: string, text: string, pagesAsFiles?: true) =>
      dispatcher.dispatch({
        id,
        authToken: 'test-token',
        method: 'connector.reply',
        params: { sessionId: SESSION_ID, replyId: id, text, pagesAsFiles }
      })

    expect(await reply('old-cloud', HTML, true)).toMatchObject({
      ok: true,
      result: { status: 'posted' }
    })
    features.add('reply.files')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', SESSION_ID)
    vi.stubEnv('ORCA_PANE_KEY', undefined)
    vi.stubEnv('ORCA_AGENT_PANE', undefined)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI uses only call for this command.
    const client = {
      call: async (method: string, params: unknown) => {
        if (method === 'connector.act') {
          stagedNames.push(params)
          throw new Error('staging unavailable')
        }
        const response = await dispatcher.dispatch({
          id: 'cli',
          authToken: 'test-token',
          method,
          params
        })
        if (!response.ok) {
          throw new RuntimeClientError(response.error.code, response.error.message)
        }
        return response
      }
    } as unknown as HandlerContext['client']
    await dispatch(['bot', 'reply'], {
      client,
      cwd: process.cwd(),
      json: false,
      flags: new Map([['text', 'The report is ready.\n```ts\nconst format = "html"\n```']])
    })
    expect(output).toHaveBeenCalledWith('Posted to the thread.')
    expect({ sessionReads, rosterReads }).toEqual({ sessionReads: 0, rosterReads: 2 })

    await dispatch(['bot', 'reply'], {
      client,
      cwd: process.cwd(),
      json: false,
      flags: new Map([['text', HTML]])
    })
    expect(stagedNames).toMatchObject([{ verb: 'reply', args: { upload: { name: 'page.html' } } }])

    linkedToBot = false
    sessionWorkspaceId = 'folder:other-home'
    const split = vi.spyOn(htmlFences, 'splitHtmlDocumentFences')
    try {
      expect(await reply('non-bot', HTML, true)).toMatchObject({
        ok: true,
        result: { status: 'posted' }
      })
      expect(split).not.toHaveBeenCalled()
    } finally {
      split.mockRestore()
    }
    expect(replyIds).toEqual(['old-cloud', expect.any(String), expect.any(String), 'non-bot'])
  }
)
