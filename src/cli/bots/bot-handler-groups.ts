import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const BOT_HANDLER_GROUPS: HandlerGroup[] = [
  {
    name: 'bot',
    keys: ['bot list', 'bot chats', 'bot new-chat', 'bot memory forget'],
    load: async () => (await import('./bot.js')).BOT_HANDLERS
  },
  {
    name: 'bot-create',
    keys: ['bot create'],
    load: async () => (await import('./bot-create.js')).BOT_CREATE_HANDLERS
  },
  {
    name: 'bot-look-around',
    keys: ['bot suggest', 'bot look-around set'],
    load: async () => (await import('./bot-look-around.js')).BOT_LOOK_AROUND_HANDLERS
  },
  {
    name: 'bot-work',
    keys: ['bot work list', 'bot work forget'],
    load: async () => (await import('./bot-work.js')).BOT_WORK_HANDLERS
  },
  {
    name: 'bot-items',
    keys: [
      'bot item add',
      'bot item set',
      'bot item ask',
      'bot item comment',
      'bot item done',
      'bot item cancel',
      'bot item link',
      'bot item list',
      'bot item show'
    ],
    load: async () => (await import('./bot-items.js')).BOT_ITEM_HANDLERS
  },
  {
    name: 'bot-import',
    keys: ['bot import sources', 'bot import read', 'bot import plan', 'bot import done'],
    load: async () => (await import('./bot-import.js')).BOT_IMPORT_HANDLERS
  },
  {
    name: 'bot-tools',
    keys: ['bot tools', 'bot tools add', 'bot tools rm', 'bot tools connect'],
    load: async () => (await import('./bot-tools.js')).BOT_TOOLS_HANDLERS
  },
  {
    name: 'webhooks',
    keys: ['webhooks list', 'webhooks show', 'webhooks calls', 'webhooks check'],
    load: async () => (await import('../webhooks/webhooks.js')).WEBHOOK_HANDLERS
  },
  {
    name: 'bot-reply',
    keys: ['bot reply'],
    load: async () => (await import('./bot-reply.js')).BOT_REPLY_HANDLERS
  },
  {
    name: 'bot-connectors',
    keys: ['bot connectors'],
    load: async () => (await import('./bot-connectors.js')).BOT_CONNECTORS_HANDLERS
  },
  {
    name: 'bot-google-setup',
    keys: [
      'bot google-setup show',
      'bot google-setup start',
      'bot google-setup step',
      'bot google-setup need-user',
      'bot google-setup set',
      'bot google-setup answer',
      'bot google-setup done',
      'bot google-setup fail'
    ],
    load: async () => (await import('./bot-google-setup.js')).BOT_GOOGLE_SETUP_HANDLERS
  },
  {
    name: 'bot-composio',
    keys: ['bot composio setup', 'bot composio events'],
    load: async () => (await import('./bot-composio.js')).BOT_COMPOSIO_HANDLERS
  },
  {
    name: 'google',
    keys: [
      'google status',
      'google client import',
      'google client export',
      'google connect',
      'google disconnect',
      'google bot'
    ],
    load: async () => (await import('../google/google.js')).GOOGLE_HANDLERS
  },
  {
    name: 'google-read',
    keys: ['gmail search', 'gmail read', 'calendar list', 'calendar get', 'contacts find'],
    load: async () => (await import('../google/google-read.js')).GOOGLE_READ_HANDLERS
  },
  {
    name: 'google-files',
    keys: [
      'drive search',
      'drive list',
      'drive read',
      'drive upload',
      'drive mkdir',
      'drive move',
      'drive share',
      'docs read',
      'docs create',
      'docs append',
      'docs replace',
      'docs comment',
      'sheets create',
      'sheets read',
      'sheets write',
      'sheets append',
      'sheets upsert'
    ],
    load: async () => (await import('../google/google-files.js')).GOOGLE_FILES_HANDLERS
  },
  {
    name: 'google-write',
    keys: [
      'gmail draft',
      'gmail send',
      'gmail archive',
      'gmail label',
      'gmail mark-read',
      'calendar create',
      'calendar update',
      'calendar delete',
      'calendar respond',
      'calendar suggest-time'
    ],
    load: async () => (await import('../google/google-write.js')).GOOGLE_WRITE_HANDLERS
  },
  {
    name: 'slack',
    keys: [
      'slack find',
      'slack check',
      'slack read',
      'slack post',
      'slack react',
      'slack edit',
      'slack delete',
      'slack attach'
    ],
    load: async () => (await import('../slack/slack.js')).SLACK_HANDLERS
  }
]
