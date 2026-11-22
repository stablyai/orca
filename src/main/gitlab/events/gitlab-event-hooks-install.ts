// GitLab events on the host that holds webhooks: its upkeep pass at start, every half hour, and soon
// after automations change.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { noteInChat } from '../../bots/bot-chat-status-line'
import { ComposioUpkeep } from '../../composio/composio-upkeep'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { WebhookHostService } from '../../webhooks/webhook-host-service'
import { GitLabEventHooks, GitLabEventHookStore } from './gitlab-event-hooks'
import { glabProjectHooks } from './gitlab-project-hooks'

export function installGitLabEventHooks(
  runtime: OrcaRuntimeService,
  webhooks: WebhookHostService,
  userDataPath: string
): ComposioUpkeep {
  const hooks = new GitLabEventHooks(
    {
      automations: () => webhooks.automations(),
      keyGeneration: async (hookId) => (await webhooks.card(hookId)).keyGeneration,
      url: async (hookId) => (await webhooks.reveal(hookId)).url,
      setSecret: async (hookId, secret) => {
        await webhooks.setSecret({ hookId, operationId: randomUUID(), adapter: 'standard', secret })
      },
      tell: (botId, line) =>
        noteInChat(
          runtime.bots.list().find((bot) => bot.id === botId)?.chatSessionId ?? undefined,
          line
        )
    },
    glabProjectHooks,
    new GitLabEventHookStore(join(userDataPath, 'gitlab-event-hooks.json'))
  )
  const upkeep = new ComposioUpkeep(() => hooks.reconcile(), 'gitlab-events')
  upkeep.start()
  return upkeep
}
