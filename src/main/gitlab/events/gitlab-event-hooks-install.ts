// GitLab events on the host that holds webhooks: its upkeep pass at start, every half hour, and soon
// after automations change.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { noteInChat } from '../../bots/bot-chat-status-line'
import { ComposioUpkeep } from '../../composio/composio-upkeep'
import { createEncryptedApiKeyFileStore } from '../../credentials/encrypted-api-key-file-store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { WebhookHostService } from '../../webhooks/webhook-host-service'
import {
  GitLabEventHooks,
  GitLabEventHookStore,
  type GitLabHookSecrets
} from './gitlab-event-hooks'
import { glabProjectHooks } from './gitlab-project-hooks'

/** Each hook's signing secret in its own encrypted file in ~/.orca, as the Composio key is kept. */
function encryptedHookSecrets(): GitLabHookSecrets {
  const stores = new Map<string, ReturnType<typeof createEncryptedApiKeyFileStore>>()
  const storeOf = (hookId: string) => {
    let store = stores.get(hookId)
    if (!store) {
      store = createEncryptedApiKeyFileStore({
        fileName: `gitlab-event-hook-${hookId}.enc`,
        envelopePrefix: 'orca-gitlab-event-hook-secret:v1:',
        providerLabel: 'GitLab webhook',
        logScope: 'gitlab-events'
      })
      stores.set(hookId, store)
    }
    return store
  }
  return {
    // An unreadable secret is made again at the next change, and every webhook and the hook take it.
    read: (hookId) =>
      storeOf(hookId)
        .read()
        .catch(() => null),
    save: (hookId, secret) => storeOf(hookId).save(secret),
    clear: (hookId) => storeOf(hookId).clear()
  }
}

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
    new GitLabEventHookStore(join(userDataPath, 'gitlab-event-hooks.json')),
    encryptedHookSecrets()
  )
  const upkeep = new ComposioUpkeep(() => hooks.reconcile(), 'gitlab-events')
  upkeep.start()
  return upkeep
}
