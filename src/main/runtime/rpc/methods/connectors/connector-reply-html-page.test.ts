import { afterEach, expect, it } from 'vitest'
import type { ConnectorCloudFeature } from '../../../../../shared/connector-cloud-features'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { CONNECTOR_METHODS } from './connector'

const HTML = '```html\n<!doctype html>\n<html><body>Report</body></html>\n```'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'

afterEach(() => setStructuredAgentSessionHost(null))

it.each([20, 200])(
  'only rediscovers a bot for a reply that can become an HTML file (%i bots)',
  async (botCount) => {
    const bots = Array.from({ length: botCount }, (_, index) => ({
      id: `bot-${index}`,
      folderWorkspaceId: `home-${index}`
    }))
    const bot = bots.at(-1)!
    const worktreeId = `folder:${bot.folderWorkspaceId}`
    let sessionReads = 0
    let rosterReads = 0
    const features = new Set<ConnectorCloudFeature>(['actions', 'files.direct'])
    const host = {
      deps: {
        store: {
          getConversation: () => {
            sessionReads++
            return { location: { workspaceId: worktreeId } }
          }
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this route only reads the conversation store from the host.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
    const replyIds: string[] = []
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
          worktreeId,
          bot: { kind: 'bot', botId: bot.id }
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
    const reply = (id: string, text: string) =>
      dispatcher.dispatch({
        id,
        authToken: 'test-token',
        method: 'connector.reply',
        params: { sessionId: SESSION_ID, replyId: id, text, pagesAsFiles: true }
      })

    expect(await reply('old-cloud', HTML)).toMatchObject({ ok: true, result: { status: 'posted' } })
    features.add('reply.files')
    expect(await reply('ordinary', 'The report is ready.')).toMatchObject({
      ok: true,
      result: { status: 'posted' }
    })
    expect({ sessionReads, rosterReads }).toEqual({ sessionReads: 0, rosterReads: 2 })

    expect(await reply('page', HTML)).toMatchObject({
      ok: false,
      error: { code: 'html_document_as_file' }
    })
    expect(replyIds).toEqual(['old-cloud', 'ordinary'])
  }
)
