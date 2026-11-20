import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findBotImportSources } from './bot-import-sources'

let home: string

async function file(path: string, text = ''): Promise<void> {
  await mkdir(join(home, path, '..'), { recursive: true })
  await writeFile(join(home, path), text)
}

const env = () => ({ home, platform: 'linux' as const, env: {} })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-import-sources-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('bots other apps keep on this computer', () => {
  it('finds nothing on a clean computer', async () => {
    expect(await findBotImportSources(env(), [])).toEqual([])
  })

  it('lists OpenClaw agents by their IDENTITY.md name, with each workspace', async () => {
    await file('.openclaw/openclaw.json', '{ channels: { slack: { botToken: "xoxb-PLANTED" } } }')
    await mkdir(join(home, '.openclaw/agents/main/agent'), { recursive: true })
    await mkdir(join(home, '.openclaw/agents/scout'), { recursive: true })
    await file(
      '.openclaw/workspace/IDENTITY.md',
      '# Identity\n\n- **Name:** Molty\n- **Vibe:** calm\n'
    )
    await mkdir(join(home, '.openclaw/workspace-scout'), { recursive: true })
    expect(await findBotImportSources(env(), [])).toEqual([
      {
        app: 'openclaw',
        home: '~/.openclaw',
        bots: [
          {
            agent: 'main',
            name: 'Molty',
            path: '~/.openclaw/workspace',
            absolutePath: join(home, '.openclaw/workspace')
          },
          {
            agent: 'scout',
            name: 'Scout',
            path: '~/.openclaw/workspace-scout',
            absolutePath: join(home, '.openclaw/workspace-scout')
          }
        ]
      }
    ])
  })

  it('takes an older OpenClaw name and a lone default workspace', async () => {
    await mkdir(join(home, '.clawdbot/workspace'), { recursive: true })
    const [source] = await findBotImportSources(env(), [])
    expect(source).toMatchObject({
      app: 'openclaw',
      home: '~/.clawdbot',
      bots: [{ agent: 'main' }]
    })
  })

  it('lists importable Hermes profiles and links a previously imported one', async () => {
    await file('.hermes/SOUL.md', 'You are Hermes.')
    await file('.hermes/profiles/research-desk/config.yaml', 'model: x\n')
    await mkdir(join(home, '.hermes/profiles/empty'), { recursive: true })
    await file('.hermes/profiles/.deleted/old/SOUL.md')
    const [source] = await findBotImportSources(env(), [
      { id: 'b1', name: 'Hermy', importedFrom: { app: 'hermes', path: join(home, '.hermes') } }
    ])
    expect(source?.bots).toMatchObject([
      { agent: 'default', name: 'Hermes', importedAs: { botId: 'b1', name: 'Hermy' } },
      { agent: 'research-desk', name: 'Research desk' }
    ])
    expect(source?.bots[1]?.importedAs).toBeUndefined()
  })

  it('lists OpenBot agents from their folders', async () => {
    await mkdir(join(home, '.config/OpenBot'), { recursive: true })
    await mkdir(join(home, 'OpenBot/Agents/agent-research'), { recursive: true })
    await mkdir(join(home, 'OpenBot/Agents/bot-8c41d0f2-6b5a-4e93-8d17-2a0b3c4d5e6f'), {
      recursive: true
    })
    const [source] = await findBotImportSources(env(), [])
    expect(source?.bots.map((bot) => bot.name)).toEqual(['Research', 'OpenBot agent'])
  })
})
