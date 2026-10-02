import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  withCodexHomeProcessLock,
  resolveCodexHomeProcessLockKey
} from '../codex-cli/codex-home-process-lock'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { generateCommitMessage } from './source-control-text-generation-requests'
import { discoverModelsLocal } from './commit-message-model-discovery'
import {
  discoverCommitMessageModelsLocal,
  generateBranchNameFromContext,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'

const folder = mkdtempSync(join(tmpdir(), 'orca-command-env-'))
const script = join(folder, 'agent.cjs')
const literal = 'spaces $HOME;$(echo unsafe) `echo unsafe` * = value'
writeFileSync(
  script,
  `
let prompt = ''
process.stdin.on('data', chunk => prompt += chunk)
process.stdin.on('end', () => {
  if (process.env.ORCA_COMMAND_VALUE !== ${JSON.stringify(literal)}) {
    console.error('command environment missing or expanded')
    process.exitCode = 3
    return
  }
  if (process.argv.includes('debug')) console.log(JSON.stringify({models:[{slug:'gpt-5.5',display_name:'GPT-5.5'}]}))
  else if (process.argv.includes('models')) console.log('anthropic/claude-sonnet-4')
  else if (prompt.includes('branch name')) console.log('honor-command-environment')
  else if (prompt.includes('JSON')) console.log(JSON.stringify({base:'main',title:'Honor command environment',body:'Passed environment.',draft:true}))
  else console.log('Honor command environment')
})
`
)
afterAll(() => rmSync(folder, { recursive: true, force: true }))

// Forward slashes remain valid Windows paths and avoid POSIX command-template escaping.
const override = `ORCA_COMMAND_VALUE='${literal}' "${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`
const target = {
  kind: 'local',
  cwd: folder,
  env: { ...process.env, ORCA_COMMAND_VALUE: 'base' }
} as const
const params = { agentId: 'custom', model: '', customAgentCommand: override } as const

describe('environment-prefixed commands with real child processes', () => {
  it.each(['generation', 'discovery'] as const)(
    'queues Codex %s on the overridden home before spawning',
    async (operation) => {
      const home = join(folder, operation).replaceAll('\\', '/')
      let release!: () => void
      const held = withCodexHomeProcessLock(
        resolveCodexHomeProcessLockKey(home),
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await Promise.resolve()
      const spawnAgent = vi.fn(spawnSourceControlAgent)
      const command = `CODEX_HOME="${home}" ${override}`
      const pending =
        operation === 'generation'
          ? generateCommitMessage({
              context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
              params: { agentId: 'codex', model: 'gpt-5.5', agentCommandOverride: command },
              target,
              spawnAgent
            })
          : discoverModelsLocal({
              agentId: 'codex',
              env: target.env,
              agentCommandOverride: command,
              options: { cwd: folder },
              backslash: process.platform === 'win32' ? 'literal' : 'escape',
              spawnAgent
            })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(spawnAgent).not.toHaveBeenCalled()
      } finally {
        release()
        await held
      }
      await expect(pending).resolves.toMatchObject(
        operation === 'discovery' ? { success: true, catalogOrigin: 'probe' } : { success: true }
      )
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: home }) })
      )
    }
  )

  it('generates commits from a custom command in a plain folder', async () => {
    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        params,
        target
      )
    ).resolves.toMatchObject({ success: true, message: 'Honor command environment' })
  })

  it('generates commits from a preset override', async () => {
    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'claude', model: 'sonnet', agentCommandOverride: override },
        target
      )
    ).resolves.toMatchObject({ success: true, message: 'Honor command environment' })
  })

  it('generates branch names', async () => {
    await expect(
      generateBranchNameFromContext({ firstPrompt: 'Honor command environment' }, params, target)
    ).resolves.toMatchObject({ success: true, slug: 'honor-command-environment' })
  })

  it.each(['github', 'gitlab'] as const)('generates %s review fields', async (provider) => {
    await expect(
      generatePullRequestFieldsFromContext(
        {
          branch: 'test',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: '',
          currentBody: '',
          currentDraft: true,
          commitSummary: 'Change',
          changeSummary: 'M README.md',
          patch: '+test',
          provider
        },
        params,
        target
      )
    ).resolves.toMatchObject({
      success: true,
      fields: {
        title: 'Honor command environment',
        body: 'Passed environment.',
        base: 'main',
        draft: true
      }
    })
  })

  it('discovers models through the same override environment', async () => {
    await expect(
      discoverCommitMessageModelsLocal('opencode', target.env, override, { cwd: folder })
    ).resolves.toMatchObject({ success: true, models: [{ id: 'anthropic/claude-sonnet-4' }] })
  })
})
