import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../shared/orca-profiles/constants'
import type { CodexManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { ModelManager } from '../../speech/model-manager'
import { setSpeechServiceFactories } from '../../speech/speech-runtime-service'
import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'

afterEach(async () => {
  setSpeechServiceFactories(null)
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('keeps an unready subscription available for login recovery', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'subscription-catalog-'))
  const store = createStore()
  const manager = new ModelManager(
    join(testState.dir, 'models'),
    () => {
      throw new Error('Catalog listing must not download models')
    },
    async () => false
  )
  setSpeechServiceFactories({
    createModelManager: () => manager,
    createSttService: () => {
      throw new Error('Catalog listing must not start recognition')
    }
  })
  const catalog = new RuntimeMobileSpeechCatalog(() => store)
  const reply = await catalog.list()
  expect(reply.models).toContainEqual(
    expect.objectContaining({
      id: 'chatgpt-subscription-transcribe',
      provider: 'chatgpt',
      status: 'not-downloaded'
    })
  )
})

it('persists the host dictation account without changing the chat account or accepting foreign accounts', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'subscription-account-selection-'))
  const store = createStore()
  const account = (id: string, email: string): CodexManagedAccount => ({
    id,
    email,
    managedHomePath: join(testState.dir, 'codex-accounts', id, 'home'),
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  })
  store.updateSettings({
    codexManagedAccounts: [
      account('chat-account', 'chat@example.com'),
      account('voice-account', 'voice@example.com'),
      { ...account('wsl-account', 'wsl@example.com'), managedHomeRuntime: 'wsl' }
    ],
    activeCodexManagedAccountId: 'chat-account',
    voice: getDefaultVoiceSettings()
  })
  const manager = new ModelManager(
    join(testState.dir, 'models'),
    () => {
      throw new Error('Account setup must not download models')
    },
    () => false
  )
  setSpeechServiceFactories({
    createModelManager: () => manager,
    createSttService: () => {
      throw new Error('Account setup must not start recognition')
    }
  })
  const catalog = new RuntimeMobileSpeechCatalog(() => store)
  const selected = await catalog.configure({ chatGptAccountId: 'voice-account' })
  expect(selected.chatGptAccountId).toBe('voice-account')
  expect(selected.chatGptAccounts).toEqual([
    { id: 'chat-account', label: 'chat@example.com' },
    { id: 'voice-account', label: 'voice@example.com' }
  ])
  expect(store.getSettings().activeCodexManagedAccountId).toBe('chat-account')
  await expect(catalog.configure({ chatGptAccountId: 'wsl-account' })).rejects.toThrow(
    'voice_chatgpt_account_unavailable'
  )
  await expect(catalog.configure({ chatGptAccountId: 'removed-account' })).rejects.toThrow(
    'voice_chatgpt_account_unavailable'
  )
  expect(store.getSettings().voice?.chatGptAccountId).toBe('voice-account')
})
