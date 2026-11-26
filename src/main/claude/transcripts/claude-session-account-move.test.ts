import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveClaudeSessionIntoAccountHome } from './claude-session-account-move'
import { ClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-router'
import { claudeLaunchResumesTranscript } from '../structured/launch/claude-structured-launch-home'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-account-resume-'))
  roots.push(root)
  const fromHome = join(root, 'a')
  const toHome = join(root, 'b')
  const providerSessionId = '11111111-1111-4111-8111-111111111111'
  const bucket = '-workspace-project'
  const source = join(fromHome, 'projects', bucket, `${providerSessionId}.jsonl`)
  const target = join(toHome, 'projects', bucket, `${providerSessionId}.jsonl`)
  await mkdir(join(fromHome, 'projects', bucket), { recursive: true })
  await writeFile(source, '{"type":"assistant","uuid":"leaf"}\n')
  return { fromHome, toHome, providerSessionId, source, target, bucket }
}

describe('moveClaudeSessionIntoAccountHome', () => {
  it.each(['leaf', null])(
    'resumes saved history under the selected account (leaf %s)',
    async (leafUuid) => {
      const f = await fixture()
      const router = new ClaudeProfileRouter({
        dataRoot: f.fromHome,
        userHome: f.fromHome,
        env: { CLAUDE_CONFIG_DIR: f.fromHome },
        getSettings: () => ({
          claudeManagedAccounts: [],
          activeClaudeManagedAccountId: null,
          disabledTuiAgents: [],
          agentStatusHooksEnabled: true
        })
      })
      await expect(
        claudeLaunchResumesTranscript({
          router,
          leafUuid,
          providerSessionId: f.providerSessionId,
          recordHome: f.fromHome,
          claudeConfigDir: f.toHome
        })
      ).resolves.toBe(true)
      expect(await readFile(f.target, 'utf8')).toEqual(await readFile(f.source, 'utf8'))
    }
  )

  it('makes history from the previous home resumable and keeps later appends', async () => {
    const f = await fixture()
    await moveClaudeSessionIntoAccountHome(f)
    expect(await readFile(f.target, 'utf8')).toEqual(await readFile(f.source, 'utf8'))
    expect((await stat(f.target)).ino).toBe((await stat(f.source)).ino)
    await appendFile(f.source, '{"uuid":"later-leaf"}\n')
    expect(await readFile(f.target, 'utf8')).toEqual(await readFile(f.source, 'utf8'))
    await moveClaudeSessionIntoAccountHome(f)
  })

  it('does not overwrite a symlink that Orca cannot resume through', async () => {
    const f = await fixture()
    await mkdir(join(f.toHome, 'projects', f.bucket), { recursive: true })
    await symlink(f.source, f.target, 'file')
    await expect(moveClaudeSessionIntoAccountHome(f)).rejects.toThrow(
      'A different Claude transcript occupies the target path.'
    )
    expect(await readFile(f.source, 'utf8')).toContain('leaf')
  })
})
