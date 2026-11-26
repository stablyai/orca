import { afterEach, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
})

it.each([20, 200])(
  'checks for HTML attachments only for eligible bot replies (%i bots)',
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
    const features = new Set<ConnectorCloudFeature>(['actions', 'files.direct', 'reply.files'])
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
    const inlinePosts: { replyId: string; text: string }[] = []
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
        reply: async ({ replyId, text }: { replyId: string; text: string }) => {
          inlinePosts.push({ replyId, text })
          return { ok: true, value: { status: 'posted' } }
        }
      })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provides the connector route's conversation and cloud seams.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: CONNECTOR_METHODS
    })
    const reply = (replyId: string, params: { text: string; pagesAsFiles?: true }) =>
      dispatcher.dispatch({
        id: replyId,
        authToken: 'test-token',
        method: 'connector.reply',
        params: { sessionId: SESSION_ID, replyId, ...params }
      })

    const split = vi.spyOn(htmlFences, 'splitHtmlDocumentFences')
    const prose = 'The report is ready.\n```ts\nconst format = "html"\n```'
    expect(await reply('prose', { text: prose })).toMatchObject({
      ok: true,
      result: { status: 'posted' }
    })
    expect({ sessionReads, rosterReads }).toEqual({ sessionReads: 0, rosterReads: 1 })
    expect(split).not.toHaveBeenCalled()

    features.delete('reply.files')
    expect(await reply('old-cloud', { text: HTML, pagesAsFiles: true })).toMatchObject({
      ok: true,
      result: { status: 'posted' }
    })
    expect({ sessionReads, rosterReads }).toEqual({ sessionReads: 0, rosterReads: 2 })
    expect(split).not.toHaveBeenCalled()

    features.add('reply.files')
    expect(await reply('bot-page', { text: HTML, pagesAsFiles: true })).toMatchObject({
      ok: false,
      error: { code: 'html_document_as_file' }
    })
    expect(split).toHaveBeenCalledWith(HTML)
    split.mockClear()

    linkedToBot = false
    sessionWorkspaceId = 'folder:other-home'
    expect(await reply('non-bot', { text: HTML, pagesAsFiles: true })).toMatchObject({
      ok: true,
      result: { status: 'posted' }
    })
    expect(split).not.toHaveBeenCalled()
    expect(inlinePosts).toEqual([
      { replyId: 'prose', text: prose },
      { replyId: 'old-cloud', text: HTML },
      { replyId: 'non-bot', text: HTML }
    ])
  }
)
