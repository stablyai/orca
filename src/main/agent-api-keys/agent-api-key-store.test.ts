import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { redactString } from '../observability/redactor'
import { AgentApiKeyStore } from './agent-api-key-store'

const ANTHROPIC = 'sk-ant-api03-store-test-value-0001'
const BEDROCK = 'bedrock-store-test-value-0002'

let root: string
let gap: string | null

function store(): AgentApiKeyStore {
  return new AgentApiKeyStore(join(root, 'agent-api-keys.json'))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-api-keys-'))
  gap = null
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (cipher) => {
      const text = cipher.toString('utf8')
      if (!text.startsWith('sealed:')) {
        throw new Error('corrupt')
      }
      return Buffer.from(text.slice('sealed:'.length), 'hex').toString('utf8')
    },
    describeProtectionGap: () => gap
  })
})

afterEach(async () => {
  _resetSecretStoreForTests()
  await rm(root, { recursive: true, force: true })
})

describe('AgentApiKeyStore', () => {
  it('keeps values sealed on disk and out of every summary', async () => {
    const keys = store()
    await keys.save({
      agent: 'claude',
      envName: 'ANTHROPIC_API_KEY',
      value: ANTHROPIC,
      hostScope: { kind: 'all' }
    })

    const disk = await readFile(join(root, 'agent-api-keys.json'), 'utf8')
    expect(disk).not.toContain(ANTHROPIC)
    expect(JSON.stringify(await keys.list())).not.toContain(ANTHROPIC)
    expect(await keys.list()).toEqual([
      expect.objectContaining({ agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: '0001' })
    ])
  })

  it('gives a launch only its agent’s keys for that host, preferring a host-specific key', async () => {
    const keys = store()
    await keys.save(
      {
        agent: 'claude',
        envName: 'ANTHROPIC_API_KEY',
        value: ANTHROPIC,
        hostScope: { kind: 'all' }
      },
      1
    )
    await keys.save(
      {
        agent: 'claude',
        envName: 'ANTHROPIC_API_KEY',
        value: 'sk-ant-api03-devbox-only-value-0003',
        hostScope: { kind: 'hosts', hostIds: ['ssh:devbox'] }
      },
      2
    )
    await keys.save(
      {
        agent: 'claude',
        envName: 'AWS_BEARER_TOKEN_BEDROCK',
        value: BEDROCK,
        hostScope: { kind: 'hosts', hostIds: ['runtime:gpu'] }
      },
      3
    )

    expect(await keys.launchEnv('claude', 'local')).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC })
    expect(await keys.launchEnv('claude-agent-teams', 'ssh:devbox')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-api03-devbox-only-value-0003'
    })
    expect(await keys.launchEnv('claude', 'runtime:gpu')).toEqual({
      ANTHROPIC_API_KEY: ANTHROPIC,
      AWS_BEARER_TOKEN_BEDROCK: BEDROCK
    })
    expect(await keys.launchEnv('codex', 'local')).toEqual({})
  })

  it('refuses subscription sign-in tokens and launch-steering variables', async () => {
    const keys = store()
    const save = (envName: string, value: string) =>
      keys.save({ agent: 'claude', envName, value, hostScope: { kind: 'all' } })

    await expect(save('ANTHROPIC_API_KEY', 'sk-ant-oat01-subscription-token')).rejects.toThrow(
      /subscription/
    )
    await expect(save('CLAUDE_CODE_OAUTH_TOKEN', 'anything-at-all')).rejects.toThrow(/subscription/)
    await expect(
      save('OPENAI_API_KEY', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl')
    ).rejects.toThrow(/subscription/)
    await expect(save('NODE_OPTIONS', '--require /tmp/x.js')).rejects.toThrow(
      /controls how the agent starts/
    )
    await expect(save('ORCA_PANE_KEY', 'x')).rejects.toThrow(/controls how the agent starts/)
    expect(await keys.list()).toEqual([])
  })

  it('refuses to save when the keychain cannot really seal', async () => {
    gap = 'Secrets are obfuscated with a built-in key.'
    await expect(
      store().save({
        agent: 'codex',
        envName: 'OPENAI_API_KEY',
        value: 'sk-proj-x1',
        hostScope: { kind: 'all' }
      })
    ).rejects.toThrow(/obfuscated/)
  })

  it('edits scope without resending the value, and removes', async () => {
    const keys = store()
    const saved = await keys.save({
      agent: 'gemini',
      envName: 'GEMINI_API_KEY',
      value: 'AIza-gemini-value-0004',
      hostScope: { kind: 'all' }
    })
    await keys.save({
      id: saved.id,
      agent: 'gemini',
      envName: 'GEMINI_API_KEY',
      hostScope: { kind: 'hosts', hostIds: ['local'] }
    })
    expect(await keys.launchEnv('gemini', 'ssh:devbox')).toEqual({})
    expect(await keys.launchEnv('gemini', 'local')).toEqual({
      GEMINI_API_KEY: 'AIza-gemini-value-0004'
    })

    await keys.remove(saved.id)
    expect(await keys.launchEnv('gemini', 'local')).toEqual({})
  })

  it('redacts a handed-out value from diagnostics', async () => {
    const keys = store()
    await keys.save({
      agent: 'cursor',
      envName: 'CURSOR_API_KEY',
      value: 'key_cursor_value_0005',
      hostScope: { kind: 'all' }
    })
    await keys.launchEnv('cursor', 'local')
    expect(redactString('spawn failed with key_cursor_value_0005 attached')).not.toContain(
      'key_cursor_value_0005'
    )
  })

  it('never overwrites a vault it cannot understand', async () => {
    const path = join(root, 'agent-api-keys.json')
    const newer = JSON.stringify({ version: 2, keys: [{ id: 'future' }] })
    await writeFile(path, newer)
    await expect(
      store().save({
        agent: 'codex',
        envName: 'OPENAI_API_KEY',
        value: 'sk-proj-x1',
        hostScope: { kind: 'all' }
      })
    ).rejects.toThrow(/could not be read/)
    expect(await readFile(path, 'utf8')).toBe(newer)
  })
})
