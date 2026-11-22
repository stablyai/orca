import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import {
  discoverCommitMessageModelsLocal,
  generateCommitMessageFromContext
} from '../commit-message-text-generation'

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
  it('generates commits from a custom command in a plain folder', async () => {
    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        params,
        target
      )
    ).resolves.toMatchObject({ success: true, message: 'Honor command environment' })
  })

  it('discovers models through the same override environment', async () => {
    await expect(
      discoverCommitMessageModelsLocal('opencode', target.env, override, { cwd: folder })
    ).resolves.toMatchObject({
      success: true,
      models: [{ id: 'default' }, { id: 'anthropic/claude-sonnet-4' }]
    })
  })
})
