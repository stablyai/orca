import { describe, expect, it } from 'vitest'
import { botImportReadRefusal } from './bot-import-read-refusal'

describe('what an importing bot may read', () => {
  it('refuses key, login and chat-history files, and reads notes', () => {
    for (const path of [
      '/h/.openclaw/.env',
      '/h/.hermes/auth.json',
      '/h/.openclaw/agents/main/agent/auth-profiles.json',
      '/h/.openclaw/credentials/whatsapp/creds.json',
      '/h/.openclaw/devices/paired.json',
      '/h/.openclaw/identity/device.json',
      '/h/.hermes/sessions/1.jsonl',
      '/h/.openclaw/workspace/skills/pr-digest/.env',
      '/h/OpenBot/openbot.db',
      '/h/.openclaw/openclaw.json',
      '/h/.hermes/config.yaml'
    ]) {
      expect(botImportReadRefusal(path), path).not.toBeNull()
    }
    for (const path of ['/h/.openclaw/workspace/MEMORY.md', '/h/.hermes/memories/USER.md']) {
      expect(botImportReadRefusal(path), path).toBeNull()
    }
  })
})
