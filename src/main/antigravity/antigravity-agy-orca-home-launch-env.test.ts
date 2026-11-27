import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// The one stand-in: the key Settings saved, as the store decrypts it. Everything else (the pinned
// spec, its env scrub, the chat-auth injection and prepare's check) is the real launch path.
const store = vi.hoisted((): { saved: string | null } => ({ saved: 'saved-key' }))
vi.mock('./antigravity-chat-api-key-store', () => ({
  readAntigravityChatApiKey: async () => store.saved,
  hasAntigravityChatApiKey: async () => store.saved !== null
}))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { antigravityAgyOrcaAccountHome } = await import('./antigravity-agy-orca-home')
const { resolveAcpLaunchInvocation } =
  await import('../acp/launch/acp-structured-launch-resolution')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  store.saved = 'saved-key'
})

function resolveKeyChat(dataDirectory: string, shell: Record<string, string>, inheritedEnv = {}) {
  return resolveAcpLaunchInvocation(
    ANTIGRAVITY_LAUNCH_SPEC,
    antigravityAgyOrcaAccountHome(dataDirectory),
    {
      resolveEnvironment: async () => shell,
      resolveCommandSettings: () => ({ antigravityChatAuth: { method: 'gemini-api-key' } }),
      resolveCommand: () => '/opt/agy/bin/agy',
      inheritedEnv,
      dataDirectory
    }
  )
}

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'agy-orca-env-'))
  folders.push(path)
  return path
}

it("launches a key chat on agy with the saved key and none of agy's own sign-in selectors", async () => {
  const dataDirectory = folder()
  const shell = {
    PATH: '/usr/bin',
    HOME: folder(),
    GOOGLE_API_KEY: 'google-key',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    AGY_ADC_AUTH: '1',
    AGY_ACCOUNT: 'me@example.com',
    AGY_LLM_GATEWAY_URL: 'https://gateway.invalid'
  }
  const invocation = await resolveKeyChat(dataDirectory, shell, {
    AGY_ADC_AUTH: '1',
    AGY_LLM_GATEWAY_API_KEY: 'gateway-key'
  })
  const { env, envToDelete } = invocation
  expect(env.GEMINI_API_KEY).toBe('saved-key')
  for (const name of [
    'AGY_ADC_AUTH',
    'AGY_ACCOUNT',
    'AGY_LLM_GATEWAY_URL',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI'
  ]) {
    expect(env).not.toHaveProperty(name)
  }
  // Orca's own process environment is dropped from the child too.
  expect(envToDelete).toEqual(expect.arrayContaining(['AGY_ADC_AUTH', 'AGY_LLM_GATEWAY_API_KEY']))
  expect(invocation.spec.args({ fullAccess: false, pluginDirs: [] })).toEqual(
    expect.arrayContaining(['--gemini-dir', join(dataDirectory, 'antigravity-agy-chat')])
  )
  // The final env passes the guard before agy starts; without its key it would not.
  const prepare = invocation.spec.account.prepare
  await expect(prepare?.(env, invocation.antigravityChatAuth)).resolves.toBeUndefined()
  const { GEMINI_API_KEY: _key, ...keyless } = env
  await expect(prepare?.(keyless, invocation.antigravityChatAuth)).rejects.toMatchObject({
    reason: 'notSignedIn'
  })
})

it('keeps a GEMINI_API_KEY the shell exports when no key is saved', async () => {
  store.saved = null
  const { env } = await resolveKeyChat(folder(), {
    PATH: '/usr/bin',
    HOME: folder(),
    GEMINI_API_KEY: 'shell-key',
    AGY_ADC_AUTH: '1'
  })
  expect(env.GEMINI_API_KEY).toBe('shell-key')
  expect(env).not.toHaveProperty('AGY_ADC_AUTH')
})
