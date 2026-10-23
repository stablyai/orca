import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareClaudeSessionResumeConfig } from './claude-session-resume-config'
import { shareClaudeProfileHistory } from '../claude-accounts/claude-profile-history'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-resume-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function transcript(home: string): Promise<string> {
  const path = join(home, 'projects', '-work-project', 'different-transcript-uuid.jsonl')
  await mkdir(join(home, 'projects', '-work-project'), { recursive: true })
  await writeFile(path, '{}\n')
  return path
}

describe('Claude resume store admission', () => {
  it('admits an existing registered account without relying on the selected account', async () => {
    const home = join(root, 'account-a', 'home')
    const path = await transcript(home)
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: {
          key: 'session_id',
          id: 'provider-id-not-file-name',
          transcriptPath: path
        },
        accountHomes: [{ configDir: home, readPath: home }],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'resume', configDir: home, userHome: root, source: 'managed' })
  })

  it('does not authorize an arbitrary existing transcript root as credentials', async () => {
    const path = await transcript(join(root, 'external', '.claude'))
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
        accountHomes: [],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'unknown-store' })
  })

  it('preserves an admitted literal explicit store even when its root ends in .claude', async () => {
    const home = join(root, "project 'quote' $value", '.claude')
    const path = await transcript(home)
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
        launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: home } },
        admittedConfig: { kind: 'explicit', value: home, userHome: root },
        accountHomes: [],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'resume', configDir: home, userHome: root, source: 'capture' })
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
        launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: home } },
        accountHomes: [],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'unknown-store' })
  })

  it('refuses a recipe whose store does not own the transcript', async () => {
    const path = await transcript(join(root, 'account-a'))
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
        launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: join(root, 'account-b') } },
        accountHomes: [],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'store-mismatch' })
  })

  it('keeps verified default unset and requires its original supported HOME', async () => {
    const path = await transcript(join(root, '.claude'))
    const args = {
      providerSession: { key: 'session_id' as const, id: 'id', transcriptPath: path },
      admittedConfig: { kind: 'default' as const, userHome: root },
      accountHomes: [],
      userHome: root
    }
    await expect(prepareClaudeSessionResumeConfig(args)).resolves.toEqual({
      outcome: 'resume',
      configDir: null,
      userHome: root,
      source: 'capture'
    })
    await expect(
      prepareClaudeSessionResumeConfig({ ...args, userHome: join(root, 'other-user') })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'store-mismatch' })
  })

  it('rejects missing transcripts and cannot create a removed account', async () => {
    const home = join(root, 'removed-account')
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: {
          key: 'session_id',
          id: 'id',
          transcriptPath: join(home, 'projects', 'p', 'id.jsonl')
        },
        accountHomes: [{ configDir: home, readPath: home }],
        userHome: root
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'missing-transcript' })
  })

  it('requires managed accounts to remain registered even with captured context or a saved recipe', async () => {
    const managedProfileRoot = join(root, 'claude-profiles')
    const home = join(managedProfileRoot, 'removed', 'home')
    const path = await transcript(home)
    const args = {
      providerSession: { key: 'session_id' as const, id: 'id', transcriptPath: path },
      accountHomes: [],
      userHome: root,
      managedProfileRoot
    }
    await expect(
      prepareClaudeSessionResumeConfig({
        ...args,
        admittedConfig: { kind: 'explicit', value: home, userHome: root }
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'unknown-store' })
    await expect(
      prepareClaudeSessionResumeConfig({
        ...args,
        launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: home } }
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'unknown-store' })
  })

  it('admits the production projects share only for a registered account and known history home', async () => {
    const home = join(root, 'claude-profiles', 'a', 'home')
    const defaultHome = join(root, '.claude')
    await mkdir(home, { recursive: true })
    await shareClaudeProfileHistory({ profileHome: home, userHome: root })
    const path = await transcript(home)
    const args = {
      providerSession: { key: 'session_id' as const, id: 'id', transcriptPath: path },
      accountHomes: [{ configDir: home, readPath: home }],
      userHome: root
    }
    await expect(
      prepareClaudeSessionResumeConfig({ ...args, sharedHistoryHomes: [defaultHome] })
    ).resolves.toEqual({ outcome: 'resume', configDir: home, userHome: root, source: 'managed' })
    await expect(prepareClaudeSessionResumeConfig(args)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'missing-transcript'
    })
    await expect(
      prepareClaudeSessionResumeConfig({ ...args, sharedHistoryHomes: [join(root, 'other')] })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'missing-transcript' })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a linked transcript escaping an admitted root',
    async () => {
      const home = join(root, 'account')
      const path = await transcript(home)
      const other = await transcript(join(root, 'other'))
      await rm(path)
      await symlink(other, path)
      await expect(
        prepareClaudeSessionResumeConfig({
          providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
          accountHomes: [{ configDir: home, readPath: home }],
          userHome: root
        })
      ).resolves.toEqual({ outcome: 'unavailable', reason: 'missing-transcript' })
    }
  )

  it('rejects a linked account ancestor while allowing aliases above its managed namespace', async () => {
    const managedProfileRoot = join(root, 'claude-profiles')
    const external = join(root, 'external-account')
    await transcript(join(external, 'home'))
    await mkdir(managedProfileRoot)
    await symlink(
      external,
      join(managedProfileRoot, 'a'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const home = join(managedProfileRoot, 'a', 'home')
    await expect(
      prepareClaudeSessionResumeConfig({
        providerSession: {
          key: 'session_id',
          id: 'id',
          transcriptPath: join(home, 'projects', '-work-project', 'different-transcript-uuid.jsonl')
        },
        accountHomes: [{ configDir: home, readPath: home }],
        userHome: root,
        managedProfileRoot
      })
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'missing-transcript' })
  })

  it('refuses traversal and malformed layouts before reading them', async () => {
    for (const path of [
      `${join(root, 'account')}/../other/projects/p/id.jsonl`,
      '/tmp/projects/id.jsonl',
      'relative/projects/p/id.jsonl'
    ]) {
      await expect(
        prepareClaudeSessionResumeConfig({
          providerSession: { key: 'session_id', id: 'id', transcriptPath: path },
          accountHomes: [],
          userHome: root
        })
      ).resolves.toEqual({ outcome: 'unavailable', reason: 'invalid-path' })
    }
  })
})
