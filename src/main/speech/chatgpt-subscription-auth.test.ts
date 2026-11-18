import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { CodexManagedAccount } from '../../shared/agent-accounts/managed-account-types'
import { getDefaultVoiceSettings } from '../../shared/orca-profiles/constants'
import {
  captureChatGptSpeechAccount,
  hasChatGptSubscriptionAuth,
  listChatGptSpeechAccounts,
  readChatGptSubscriptionHeaders,
  type ChatGptSpeechSettings
} from './chatgpt-subscription-auth'
import { ModelManager } from './model-manager'
import { resolveCloudTranscriptionTarget } from './cloud-transcription-target'
import { getSpeechModelManager, setSpeechServiceFactories } from './speech-runtime-service'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { SttService } from './stt-service'
import { setMainHttpClient } from '../network/http-client'
import * as backendAuth from '../rate-limits/providers/codex/codex-backend-auth'

let root = ''
let settings: ChatGptSpeechSettings & {
  codexManagedAccounts: CodexManagedAccount[]
  activeCodexManagedAccountId: string | null
}

function token(account: string, exp = 4_000_000_000, claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      exp,
      sub: `oauth|${account}`,
      email: `${account}@example.test`,
      'https://api.openai.com/auth': {
        chatgpt_account_id: account,
        chatgpt_user_id: `user-${account}`
      },
      ...claims
    })
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function auth(account: string, exp?: number) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: token(account, exp),
      id_token: token(account, exp, { sub: `user-${account}` }),
      account_id: account
    }
  }
}

async function createAccount(id: string): Promise<CodexManagedAccount> {
  const home = join(root, 'codex-accounts', id, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.orca-managed-home'), `${id}\n`)
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth(id)))
  return {
    id,
    email: `${id}@example.test`,
    managedHomePath: home,
    managedHomeRuntime: 'host',
    providerAccountId: id,
    workspaceAccountId: id,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-managed-speech-auth-'))
  vi.spyOn(getAppEnvironment(), 'getPath').mockReturnValue(root)
  settings = {
    voice: { ...getDefaultVoiceSettings(), chatGptAccountId: 'selected' },
    codexManagedAccounts: await Promise.all([createAccount('selected'), createAccount('active')]),
    activeCodexManagedAccountId: 'active'
  }
  setSpeechServiceFactories({
    createModelManager: (directory) =>
      new ModelManager(directory ?? join(root, 'models'), () => {
        throw new Error('Cloud models need no download')
      }),
    createSttService: () => {
      throw new Error('Authentication checks must not start recognition')
    }
  })
  getSpeechModelManager({ getSettings: () => settings })
})

afterEach(async () => {
  setSpeechServiceFactories(null)
  setMainHttpClient(null)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('uses the explicit Voice account and becomes unready when it is removed', async () => {
  const signal = new AbortController().signal
  const headers = await readChatGptSubscriptionHeaders(signal)
  expect(headers.Authorization).toBe(`Bearer ${token('selected')}`)
  expect(headers['ChatGPT-Account-Id']).toBe('selected')
  expect(headers.originator).toBe('Codex Desktop')
  expect(headers['User-Agent']).toContain('Orca/')
  const desktop = getSpeechModelManager({ getSettings: () => settings })
  expect(await desktop.getModelState('chatgpt-subscription-transcribe')).toEqual({
    id: 'chatgpt-subscription-transcribe',
    status: 'ready'
  })
  settings.codexManagedAccounts = settings.codexManagedAccounts.filter(
    (account) => account.id !== 'selected'
  )
  expect(await desktop.getModelState('chatgpt-subscription-transcribe')).toEqual({
    id: 'chatgpt-subscription-transcribe',
    status: 'not-downloaded'
  })
  expect(settings.activeCodexManagedAccountId).toBe('active')
})

it.each([undefined, 'removed'])(
  'does not inherit another login when Voice selection is %s',
  async (id) => {
    settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: id }
    vi.stubEnv('CODEX_HOME', join(root, 'codex-accounts', 'active', 'home'))
    await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
      'unconfigured or the selected account was removed'
    )
    expect(settings.activeCodexManagedAccountId).toBe('active')
  }
)

it.each([
  { accessClaim: 'chatgpt_user_id', identityClaims: { user_id: 'user-selected' } },
  {
    accessClaim: 'user_id',
    identityClaims: { chatgpt_user_id: 'user-selected', user_id: 'legacy-auth-user' }
  }
])(
  'binds the bearer to the ID token through OpenAI $accessClaim, not the OAuth subject',
  async ({ accessClaim, identityClaims }) => {
    const credentials = auth('selected')
    credentials.tokens.access_token = token('selected', undefined, {
      sub: 'auth0|login-subject',
      email: undefined,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'selected',
        [accessClaim]: 'user-selected'
      }
    })
    credentials.tokens.id_token = token('selected', undefined, {
      sub: 'different-id-token-subject',
      email: undefined,
      'https://api.openai.com/profile': { email: 'SELECTED@example.test' },
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'selected',
        ...identityClaims
      }
    })
    await writeFile(
      join(settings.codexManagedAccounts[0].managedHomePath, 'auth.json'),
      JSON.stringify(credentials)
    )
    expect((await readChatGptSubscriptionHeaders(AbortSignal.timeout(5_000))).Authorization).toBe(
      `Bearer ${credentials.tokens.access_token}`
    )
  }
)

it.each([
  {
    tokenKind: 'access_token',
    claims: {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'selected',
        chatgpt_user_id: 'user-coworker'
      }
    }
  },
  {
    tokenKind: 'access_token',
    claims: { 'https://api.openai.com/auth': { chatgpt_account_id: 'selected' } }
  },
  {
    tokenKind: 'id_token',
    claims: { 'https://api.openai.com/auth': { chatgpt_account_id: 'selected' } }
  },
  { tokenKind: 'id_token', claims: { email: 'coworker@example.test' } }
] as const)(
  'rejects another or unprovable user in the selected workspace: $tokenKind $claims',
  async ({ tokenKind, claims }) => {
    const credentials = auth('selected')
    credentials.tokens[tokenKind] = token('selected', undefined, claims)
    await writeFile(
      join(settings.codexManagedAccounts[0].managedHomePath, 'auth.json'),
      JSON.stringify(credentials)
    )
    await expect(readChatGptSubscriptionHeaders(AbortSignal.timeout(5_000))).rejects.toThrow(
      'account identity'
    )
    expect(await hasChatGptSubscriptionAuth()).toBe(false)
  }
)

it.each([
  { value: JSON.stringify(auth('selected', 1)), reason: 'has expired' },
  { value: '{"private-token-never-in-errors":', reason: 'invalid ChatGPT OAuth' },
  {
    value: JSON.stringify({
      ...auth('selected'),
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-secret'
    }),
    reason: 'not an API key'
  },
  {
    value: JSON.stringify({ ...auth('selected'), tokens: { access_token: 'sk-secret' } }),
    reason: 'invalid ChatGPT OAuth'
  },
  { value: JSON.stringify(auth('foreign')), reason: 'account identity' },
  {
    value: JSON.stringify({
      ...auth('selected'),
      tokens: { ...auth('selected').tokens, account_id: 'foreign' }
    }),
    reason: 'account identity'
  },
  {
    value: JSON.stringify({
      ...auth('selected'),
      tokens: { ...auth('selected').tokens, access_token: token('foreign') }
    }),
    reason: 'account identity'
  },
  {
    value: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token('selected') } }),
    reason: 'invalid ChatGPT OAuth'
  },
  {
    value: JSON.stringify({
      ...auth('selected'),
      tokens: { ...auth('selected').tokens, id_token: 'not-a-jwt' }
    }),
    reason: 'invalid ChatGPT OAuth'
  },
  {
    value: JSON.stringify({
      ...auth('selected'),
      tokens: {
        ...auth('selected').tokens,
        access_token: token('selected').replace(
          /^[^.]+/,
          Buffer.from('{"alg":"none"}').toString('base64url')
        )
      }
    }),
    reason: 'invalid ChatGPT OAuth'
  }
])(
  'rejects invalid selected credentials without using the healthy active account: $reason',
  async ({ value, reason }) => {
    await writeFile(join(root, 'codex-accounts', 'selected', 'home', 'auth.json'), value)
    const result = readChatGptSubscriptionHeaders(new AbortController().signal)
    await expect(result).rejects.toThrow(reason)
    await expect(result).rejects.not.toThrow('private-token-never-in-errors')
    await expect(result).rejects.not.toThrow('sk-secret')
    expect(await hasChatGptSubscriptionAuth()).toBe(false)
  }
)

it('rejects missing auth, foreign home paths, forged markers and redirected homes', async () => {
  const selected = settings.codexManagedAccounts[0]
  await rm(join(selected.managedHomePath, 'auth.json'))
  await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
    'missing, unreadable'
  )
  await writeFile(join(selected.managedHomePath, 'auth.json'), JSON.stringify(auth('selected')))
  settings.codexManagedAccounts[0] = {
    ...selected,
    managedHomePath: settings.codexManagedAccounts[1].managedHomePath
  }
  await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
    'no longer owned'
  )
  settings.codexManagedAccounts[0] = selected
  await writeFile(join(selected.managedHomePath, '.orca-managed-home'), 'active')
  await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
    'no longer owned'
  )
  await rm(selected.managedHomePath, { recursive: true })
  const outside = join(root, 'foreign-home')
  await mkdir(outside)
  await writeFile(join(outside, '.orca-managed-home'), 'selected')
  await writeFile(join(outside, 'auth.json'), JSON.stringify(auth('selected')))
  await symlink(
    outside,
    selected.managedHomePath,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
    'no longer owned'
  )
})

it('allows the linked ownership marker used by existing Windows managed homes', async () => {
  const home = settings.codexManagedAccounts[0].managedHomePath
  await rm(join(home, '.orca-managed-home'))
  await writeFile(join(home, '.orca-managed-home-linked'), 'selected')
  expect(
    (await readChatGptSubscriptionHeaders(new AbortController().signal))['ChatGPT-Account-Id']
  ).toBe('selected')
})

it('only advertises host accounts with safe labels and never reads WSL homes', async () => {
  settings.managedAccountDisplayNames = { codex: { selected: 'Personal' } }
  const wsl = {
    ...settings.codexManagedAccounts[1],
    id: 'wsl',
    managedHomeRuntime: 'wsl'
  } satisfies CodexManagedAccount
  const unc = {
    ...settings.codexManagedAccounts[1],
    id: 'unc',
    managedHomeRuntime: undefined,
    managedHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\codex'
  }
  const guestAccounts = [
    wsl,
    unc,
    {
      ...settings.codexManagedAccounts[1],
      id: 'legacy-distro',
      managedHomeRuntime: undefined,
      wslDistro: 'Ubuntu'
    },
    {
      ...settings.codexManagedAccounts[1],
      id: 'legacy-home',
      managedHomeRuntime: undefined,
      wslLinuxHomePath: '/home/user/codex'
    }
  ]
  settings.codexManagedAccounts.push(...guestAccounts)
  expect(listChatGptSpeechAccounts(settings)).toEqual([
    { id: 'selected', label: 'Personal (selected@example.test)' },
    { id: 'active', label: 'active@example.test' }
  ])
  for (const { id } of guestAccounts) {
    settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: id }
    await expect(readChatGptSubscriptionHeaders(new AbortController().signal)).rejects.toThrow(
      'unavailable'
    )
  }
})

it('pins readiness and upload to the captured account even when the new selection is unavailable', async () => {
  const sentAccounts: (string | null)[] = []
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (_url, init) => {
      sentAccounts.push(new Headers(init?.headers).get('ChatGPT-Account-Id'))
      return new Response('{"text":"dictated"}')
    }
  })
  const models = getSpeechModelManager({ getSettings: () => settings })
  const service = new SttService(models, () => {
    throw new Error('Cloud dictation must not start a recognizer')
  })
  const events = vi.fn()
  try {
    const starting = service.startDictation('chatgpt-subscription-transcribe', events)
    settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: 'removed' }
    await starting
    service.feedAudio(new Float32Array([0.1]), 16000)
    await service.stopDictation()
    settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: 'active' }
    await service.startDictation('chatgpt-subscription-transcribe', events)
    service.feedAudio(new Float32Array([0.1]), 16000)
    await service.stopDictation()
    expect(sentAccounts).toEqual(['selected', 'active'])
    expect(events).toHaveBeenCalledWith({ type: 'final', text: 'dictated' })
  } finally {
    await service.stopDictation(undefined, { discard: true })
    await service.unloadIdleModel()
  }
})

it('does not make an unconfigured capture ready when Voice gains a valid account during startup', async () => {
  settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: undefined }
  const service = new SttService(getSpeechModelManager({ getSettings: () => settings }), () => {
    throw new Error('Cloud dictation must not start a recognizer')
  })
  const events = vi.fn()
  const starting = service.startDictation('chatgpt-subscription-transcribe', events)
  settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: 'active' }
  try {
    await expect(starting).rejects.toThrow('unconfigured or the selected account was removed')
    expect(events).not.toHaveBeenCalledWith({ type: 'ready' })
  } finally {
    await service.stopDictation(undefined, { discard: true })
    await service.unloadIdleModel()
  }
})

it.each(['removed', 'identity-changed'])(
  'fails a pinned capture whose account is %s rather than switching',
  async (change) => {
    const session = new OpenAiTranscriptionSession(
      () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
      undefined,
      captureChatGptSpeechAccount()
    )
    session.feedAudio(new Float32Array([0.1]), 16000)
    settings.voice = { ...getDefaultVoiceSettings(), chatGptAccountId: 'active' }
    settings.codexManagedAccounts =
      change === 'removed'
        ? settings.codexManagedAccounts.slice(1)
        : settings.codexManagedAccounts.map((account) =>
            account.id === 'selected' ? { ...account, providerAccountId: 'foreign' } : account
          )
    const upload = vi.fn()
    setMainHttpClient({ proxySession: () => null, fetch: upload })
    await expect(session.finish()).rejects.toThrow(/removed|changed account identity/)
    expect(upload).not.toHaveBeenCalled()
  }
)

it('cancels an in-flight managed auth read without uploading or falling back', async () => {
  const controller = new AbortController()
  const selection = captureChatGptSpeechAccount()
  vi.spyOn(backendAuth, 'readCodexBackendAuthContents').mockImplementation(
    async (_path, signal) => {
      controller.abort()
      signal.throwIfAborted()
      throw new Error('unreachable')
    }
  )
  await expect(readChatGptSubscriptionHeaders(controller.signal, selection)).rejects.toMatchObject({
    name: 'AbortError'
  })
  await expect(readChatGptSubscriptionHeaders(AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError'
  })
})
