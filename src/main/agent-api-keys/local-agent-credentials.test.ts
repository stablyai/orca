import { describe, expect, it } from 'vitest'
import { readLocalAgentCredentials } from './local-agent-credentials'

const HOME = '/home/u'
function files(map: Record<string, string>) {
  return {
    readText: async (path: string) => map[path] ?? null,
    exists: async (path: string) => path in map
  }
}

describe('readLocalAgentCredentials', () => {
  it('offers OpenCode API keys under the env names the egress proxy swaps, and lists OAuth sign-ins without copying them', async () => {
    const auth = JSON.stringify({
      anthropic: {
        type: 'oauth',
        refresh: 'rt-secret',
        access: 'at-secret',
        expires: 1
      },
      openai: { type: 'api', key: 'sk-proj-openai-1234' },
      google: { type: 'api', key: 'AIzaSy-google-5678' },
      vercel: { type: 'api', key: 'vck_gateway_9012' },
      openrouter: { type: 'api', key: 'sk-or-not-swapped' },
      'github-copilot': {
        type: 'oauth',
        refresh: 'gho_x',
        access: 'y',
        expires: 2
      }
    })
    const found = await readLocalAgentCredentials({
      home: HOME,
      env: {},
      ...files({ '/home/u/.local/share/opencode/auth.json': auth })
    })
    expect(found.keys).toEqual([
      {
        name: 'OPENAI_API_KEY',
        value: 'sk-proj-openai-1234',
        source: 'opencode-auth'
      },
      {
        name: 'GOOGLE_GENERATIVE_AI_API_KEY',
        value: 'AIzaSy-google-5678',
        source: 'opencode-auth'
      },
      {
        name: 'AI_GATEWAY_API_KEY',
        value: 'vck_gateway_9012',
        source: 'opencode-auth'
      }
    ])
    expect(found.signIns).toEqual([
      { agent: 'opencode', provider: 'anthropic' },
      { agent: 'opencode', provider: 'github-copilot' }
    ])
    expect(JSON.stringify(found)).not.toMatch(/rt-secret|at-secret|gho_x|sk-or-not-swapped/)
  })

  it('reads Gemini keys from ~/.gemini/.env and Cursor/Gemini keys from the shell env; first source wins', async () => {
    const found = await readLocalAgentCredentials({
      home: HOME,
      env: {
        GEMINI_API_KEY: 'AIzaSy-shell-0000',
        CURSOR_API_KEY: 'key_cursor_shell_1',
        ANTHROPIC_API_KEY: ' '
      },
      ...files({
        '/home/u/.gemini/.env': 'export GEMINI_API_KEY="AIzaSy-file-1111"\nOTHER=x\n',
        '/home/u/.gemini/oauth_creds.json': '{}'
      })
    })
    expect(found.keys).toEqual([
      {
        name: 'GEMINI_API_KEY',
        value: 'AIzaSy-file-1111',
        source: 'gemini-env-file'
      },
      {
        name: 'CURSOR_API_KEY',
        value: 'key_cursor_shell_1',
        source: 'shell-env'
      }
    ])
    expect(found.signIns).toEqual([{ agent: 'gemini', provider: 'google' }])
  })

  it('ignores unreadable files and honours XDG_DATA_HOME', async () => {
    expect(
      await readLocalAgentCredentials({
        home: HOME,
        env: {},
        ...files({
          '/home/u/.local/share/opencode/auth.json': '{not json'
        })
      })
    ).toEqual({ keys: [], signIns: [] })
    const auth = JSON.stringify({
      anthropic: { type: 'api', key: 'sk-ant-api03-xdg' }
    })
    expect(
      (
        await readLocalAgentCredentials({
          home: HOME,
          env: { XDG_DATA_HOME: '/data' },
          ...files({ '/data/opencode/auth.json': auth })
        })
      ).keys
    ).toEqual([
      {
        name: 'ANTHROPIC_API_KEY',
        value: 'sk-ant-api03-xdg',
        source: 'opencode-auth'
      }
    ])
  })
})
