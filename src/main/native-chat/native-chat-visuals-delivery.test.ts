import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH,
  NATIVE_CHAT_VISUAL_MAX_BYTES,
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH,
  parseNativeChatVisualDirectiveLine
} from '../../shared/native-chat-visual-directive'
import { NATIVE_CHAT_VISUAL_THEME_TOKENS } from '../../shared/native-chat-visual-shell'
import { ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS } from '../../shared/orcad-artifacts'
import {
  createNativeChatVisualsDelivery,
  NATIVE_CHAT_VISUALS_DIR_ENV,
  withNativeChatVisualsEnv
} from './native-chat-visuals-delivery'
import { nativeChatVisualsFolderFor } from './native-chat-visuals-folder'
import { buildClaudeChildProcessEnv } from '../claude/claude-child-process-environment'
import { codexStructuredChildEnvironment } from '../codex/codex-structured-child-environment'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import {
  NATIVE_CHAT_VISUALS_SKILL_NAME,
  resetNativeChatVisualsSkillLocationForTests,
  resolveNativeChatVisualsSkillLocation
} from './native-chat-visuals-skill-location'

const RESOURCE_DIR = join(__dirname, '..', '..', '..', 'resources', 'native-chat-visuals')
const SKILL_TEXT = readFileSync(
  join(RESOURCE_DIR, 'skills', NATIVE_CHAT_VISUALS_SKILL_NAME, 'SKILL.md'),
  'utf8'
)
const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }

const scratch: string[] = []
afterEach(() => {
  resetNativeChatVisualsSkillLocationForTests()
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-visuals-delivery-'))
  scratch.push(dir)
  return dir
}

const logger = () => ({ warn: vi.fn(), error: vi.fn() })

describe('preparing a chat for visuals', () => {
  it("creates the chat's own private folder and hands back the skill", async () => {
    const state = tempDir()
    const prepare = createNativeChatVisualsDelivery({
      stateDirectory: state,
      logger: logger(),
      resolveSkill: async () => SKILL
    })
    const prepared = await prepare('chat-1')
    expect(prepared).toEqual({ folder: nativeChatVisualsFolderFor(state, 'chat-1'), skill: SKILL })
    const mode = statSync(prepared!.folder).mode & 0o777
    expect(process.platform === 'win32' || mode === 0o700).toBe(true)
    // A second launch of the same chat reuses it.
    await expect(prepare('chat-1')).resolves.toEqual(prepared)
  })

  it('leaves the chat without visuals when the skill is missing or the folder fails', async () => {
    const missingSkill = logger()
    await expect(
      createNativeChatVisualsDelivery({
        stateDirectory: tempDir(),
        logger: missingSkill,
        resolveSkill: async () => null
      })('chat-1')
    ).resolves.toBeNull()
    expect(missingSkill.warn).toHaveBeenCalledOnce()
    // A file where the visuals root should be makes every mkdir fail.
    const state = tempDir()
    writeFileSync(join(state, 'native-chat-visuals'), 'not a folder')
    const failedFolder = logger()
    await expect(
      createNativeChatVisualsDelivery({
        stateDirectory: state,
        logger: failedFolder,
        resolveSkill: async () => SKILL
      })('chat-1')
    ).resolves.toBeNull()
    expect(failedFolder.warn).toHaveBeenCalledWith(
      'native-chat visuals folder could not be prepared',
      expect.objectContaining({ scope: 'nativeChatVisuals.folder', sessionId: 'chat-1' })
    )
  })

  it("never hands a chat another chat's folder that Orca itself inherited", () => {
    const inherited = { PATH: '/bin', [NATIVE_CHAT_VISUALS_DIR_ENV]: '/parent-chat' }
    const visuals = { folder: '/mine', skill: SKILL }
    for (const platform of ['darwin', 'win32'] as const) {
      const claude = (configured: Record<string, string>) =>
        buildClaudeChildProcessEnv(configured, { inheritedEnv: inherited, platform })
      expect(claude({})).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
      expect(claude(withNativeChatVisualsEnv({}, visuals))[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(
        '/mine'
      )
    }
    const codex = (withVisuals: boolean) =>
      resolveProviderChildEnv(
        codexStructuredChildEnvironment(
          {
            command: 'codex',
            args: ['app-server'],
            cwd: '/w',
            codexHome: null,
            resumeThreadId: null,
            ...(withVisuals ? { visuals } : {})
          },
          'spawn-token',
          'chat-1'
        ),
        inherited
      )
    expect(codex(false)).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
    expect(codex(true)[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe('/mine')
  })

  it('names only this chat folder to the agent', () => {
    const inherited = { PATH: '/bin', [NATIVE_CHAT_VISUALS_DIR_ENV]: '/other-chat' }
    expect(withNativeChatVisualsEnv(inherited, { folder: '/mine', skill: SKILL })).toEqual({
      PATH: '/bin',
      [NATIVE_CHAT_VISUALS_DIR_ENV]: '/mine'
    })
    expect(withNativeChatVisualsEnv(inherited, null)).toEqual({ PATH: '/bin' })
  })
})

describe('the bundled skill', () => {
  it('is found in a checkout, and a missing install is not remembered', async () => {
    await expect(resolveNativeChatVisualsSkillLocation([tempDir()])).resolves.toBeNull()
    await expect(resolveNativeChatVisualsSkillLocation([tempDir(), RESOURCE_DIR])).resolves.toEqual(
      { pluginDir: RESOURCE_DIR, skillsRoot: join(RESOURCE_DIR, 'skills') }
    )
  })

  it('ships every file in the headless server build too', () => {
    const shipped = ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS.map((file) =>
      file.slice('native-chat-visuals/'.length)
    )
    expect(shipped).toEqual([
      '.claude-plugin/plugin.json',
      `skills/${NATIVE_CHAT_VISUALS_SKILL_NAME}/SKILL.md`
    ])
    const manifest = JSON.parse(readFileSync(join(RESOURCE_DIR, shipped[0]!), 'utf8'))
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/)
  })

  it('teaches the reply line the renderer parses, with its limits', () => {
    const example = SKILL_TEXT.split('\n').find((line) => line.startsWith('::orca-visual{'))
    expect(example && parseNativeChatVisualDirectiveLine(example)).toEqual({
      file: 'latency-by-region-7c1e.html',
      title: 'Latency by region'
    })
    expect(SKILL_TEXT).toContain(`At most ${NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE} visuals`)
    expect(SKILL_TEXT).toContain(`at most ${NATIVE_CHAT_VISUAL_FILE_MAX_LENGTH} characters`)
    expect(SKILL_TEXT).toContain(`at most ${NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH}`)
    expect(SKILL_TEXT).toContain(`under ${NATIVE_CHAT_VISUAL_MAX_BYTES / 1024} KB`)
    expect(SKILL_TEXT).toContain(NATIVE_CHAT_VISUALS_DIR_ENV)
    expect(SKILL_TEXT).toMatch(new RegExp(`^name: ${NATIVE_CHAT_VISUALS_SKILL_NAME}$`, 'm'))
  })

  it('names only theme variables the visual frame sets', () => {
    const named = [...SKILL_TEXT.matchAll(/`(--[a-z0-9-]+)`/g)].map(([, name]) => name)
    const ranges = [...SKILL_TEXT.matchAll(/`--chart-1` to `--chart-(\d)`/g)].flatMap(([, last]) =>
      Array.from({ length: Number(last) }, (_, index) => `--chart-${index + 1}`)
    )
    expect(named.length).toBeGreaterThan(0)
    const frameTokens: readonly string[] = NATIVE_CHAT_VISUAL_THEME_TOKENS
    expect([...named, ...ranges].filter((name) => !frameTokens.includes(name))).toEqual([])
  })
})
