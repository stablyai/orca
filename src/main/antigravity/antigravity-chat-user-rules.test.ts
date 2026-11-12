import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadAntigravityUserRules,
  resolveAntigravitySessionMeta,
  resolveAntigravityUserRulesMeta
} from './antigravity-chat-user-rules'

describe('antigravity user rules', () => {
  let tempDir: string
  let homeDir: string
  let workspaceDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-antigravity-rules-test-'))
    homeDir = join(tempDir, 'home')
    workspaceDir = join(tempDir, 'workspace')
    await mkdir(homeDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns undefined when no rules files exist and workflow safety is off', async () => {
    const meta = await resolveAntigravityUserRulesMeta({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })
    expect(meta).toBeUndefined()
    await expect(
      resolveAntigravitySessionMeta({ cwd: workspaceDir, env: { HOME: homeDir } })
    ).resolves.toBeUndefined()
  })

  it('composes run_workflow disablement with user rules when both apply', async () => {
    await expect(
      resolveAntigravitySessionMeta({
        cwd: workspaceDir,
        env: { HOME: homeDir },
        disableRunWorkflow: true
      })
    ).resolves.toEqual({
      antigravity: {
        disabledTools: ['run_workflow']
      }
    })

    await writeFile(join(workspaceDir, 'AGENTS.md'), '# Team Rules', 'utf8')
    const combined = await resolveAntigravitySessionMeta({
      cwd: workspaceDir,
      env: { HOME: homeDir },
      disableRunWorkflow: true
    })
    expect(combined).toMatchObject({
      antigravity: {
        disabledTools: ['run_workflow'],
        systemPrompt: {
          append: expect.stringContaining('# Team Rules')
        }
      }
    })
  })

  it('loads global rules from ~/.gemini/GEMINI.md with user_global tag', async () => {
    const geminiDir = join(homeDir, '.gemini')
    await mkdir(geminiDir, { recursive: true })
    const ruleContent = '# My Global Guidelines\n- Always be clear and direct.'
    await writeFile(join(geminiDir, 'GEMINI.md'), ruleContent, 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toContain('<user_rules>')
    expect(rules).toContain(
      '<RULE[user_global]>\n# My Global Guidelines\n- Always be clear and direct.\n</RULE[user_global]>'
    )
    expect(rules).toContain('</user_rules>')

    const meta = await resolveAntigravityUserRulesMeta({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })
    expect(meta).toEqual({
      antigravity: {
        systemPrompt: {
          append: rules
        }
      }
    })
  })

  it('loads global rules from ~/.gemini/AGENTS.md when GEMINI.md is absent', async () => {
    const geminiDir = join(homeDir, '.gemini')
    await mkdir(geminiDir, { recursive: true })
    const ruleContent = '# Global Agents Rules'
    await writeFile(join(geminiDir, 'AGENTS.md'), ruleContent, 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toContain('<RULE[user_global]>\n# Global Agents Rules\n</RULE[user_global]>')
  })

  it('loads workspace rules from <cwd>/AGENTS.md with file path tag', async () => {
    const ruleContent = '# Workspace Rules\nRun pnpm test.'
    const agentsPath = join(workspaceDir, 'AGENTS.md')
    await writeFile(agentsPath, ruleContent, 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toContain(
      `<RULE[${agentsPath}]>\n# Workspace Rules\nRun pnpm test.\n</RULE[${agentsPath}]>`
    )
  })

  it('loads workspace rules from <cwd>/GEMINI.md when AGENTS.md is absent', async () => {
    const ruleContent = '# Workspace Gemini Rules'
    const geminiPath = join(workspaceDir, 'GEMINI.md')
    await writeFile(geminiPath, ruleContent, 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toContain(
      `<RULE[${geminiPath}]>\n# Workspace Gemini Rules\n</RULE[${geminiPath}]>`
    )
  })

  it('combines both global and workspace rules in order', async () => {
    const geminiDir = join(homeDir, '.gemini')
    await mkdir(geminiDir, { recursive: true })
    await writeFile(join(geminiDir, 'GEMINI.md'), 'Global rule body', 'utf8')

    const agentsPath = join(workspaceDir, 'AGENTS.md')
    await writeFile(agentsPath, 'Workspace rule body', 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toBe(
      '<user_rules>\n' +
        'The following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION. These rules take precedence over any other instructions.\n' +
        'Review them carefully and always take them into account when you generate responses and code:\n' +
        '<RULE[user_global]>\n' +
        'Global rule body\n' +
        '</RULE[user_global]>\n' +
        `<RULE[${agentsPath}]>\n` +
        'Workspace rule body\n' +
        `</RULE[${agentsPath}]>\n` +
        '</user_rules>'
    )
  })

  it('loads both AGENTS.md and GEMINI.md when a workspace has both', async () => {
    const agentsPath = join(workspaceDir, 'AGENTS.md')
    const geminiPath = join(workspaceDir, 'GEMINI.md')
    await writeFile(agentsPath, 'Agents rule body', 'utf8')
    await writeFile(geminiPath, 'Gemini rule body', 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toBe(
      '<user_rules>\n' +
        'The following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION. These rules take precedence over any other instructions.\n' +
        'Review them carefully and always take them into account when you generate responses and code:\n' +
        `<RULE[${agentsPath}]>\n` +
        'Agents rule body\n' +
        `</RULE[${agentsPath}]>\n` +
        `<RULE[${geminiPath}]>\n` +
        'Gemini rule body\n' +
        `</RULE[${geminiPath}]>\n` +
        '</user_rules>'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'deduplicates symlinked workspace rule files',
    async () => {
      const agentsPath = join(workspaceDir, 'AGENTS.md')
      const geminiPath = join(workspaceDir, 'GEMINI.md')
      await writeFile(agentsPath, 'Shared rules content', 'utf8')
      await symlink(agentsPath, geminiPath)

      const rules = await loadAntigravityUserRules({
        cwd: workspaceDir,
        env: { HOME: homeDir }
      })

      const matches = rules?.match(/Shared rules content/g)
      expect(matches).toHaveLength(1)
    }
  )

  it('bounds rule file reading to MAX_RULE_FILE_BYTES', async () => {
    const largeContent = 'x'.repeat(300 * 1024)
    await writeFile(join(workspaceDir, 'AGENTS.md'), largeContent, 'utf8')

    const rules = await loadAntigravityUserRules({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })

    expect(rules).toBeDefined()
    expect(rules!.length).toBeLessThan(300 * 1024)
    expect(rules).toContain('xxxx')
  })

  it('handles unexpected filesystem or home errors without throwing', async () => {
    const rules = await loadAntigravityUserRules({
      cwd: '\0invalid-cwd-path',
      env: { HOME: homeDir }
    })
    expect(rules).toBeUndefined()
  })

  it('ignores empty or whitespace-only rule files', async () => {
    const geminiDir = join(homeDir, '.gemini')
    await mkdir(geminiDir, { recursive: true })
    await writeFile(join(geminiDir, 'GEMINI.md'), '   \n  \t  \n', 'utf8')
    await writeFile(join(workspaceDir, 'AGENTS.md'), '', 'utf8')

    const meta = await resolveAntigravityUserRulesMeta({
      cwd: workspaceDir,
      env: { HOME: homeDir }
    })
    expect(meta).toBeUndefined()
  })
})
