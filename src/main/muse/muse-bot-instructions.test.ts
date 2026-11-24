import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { deliverMuseBotInstructions } from './muse-bot-instructions'

it('writes Muse instructions only to an Orca-managed non-Git bot home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-muse-rules-'))
  const botsRoot = join(root, 'bots')
  const cwd = join(botsRoot, 'test-bot')
  const rules = join(cwd, 'AGENTS.md')
  const input = { cwd, text: 'Follow the bot rules.' }
  try {
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'bot.json'), '{}')
    await writeFile(rules, '# Workspace rules\n')

    await expect(deliverMuseBotInstructions(input, botsRoot)).resolves.toEqual({
      args: ['--trust-workspace']
    })
    await deliverMuseBotInstructions({ ...input, text: 'Updated bot rules.' }, botsRoot)
    const updated =
      '# Workspace rules\n\n<!-- orca:begin -->\nUpdated bot rules.\n<!-- orca:end -->\n'
    expect(await readFile(rules, 'utf8')).toBe(updated)

    for (const gitMarker of [join(cwd, '.git'), join(root, '.git')]) {
      await writeFile(gitMarker, 'gitdir: /example/worktree')
      await expect(deliverMuseBotInstructions(input, botsRoot)).rejects.toThrow(
        'require an Orca bot home outside Git'
      )
      expect(await readFile(rules, 'utf8')).toBe(updated)
      await rm(gitMarker)
    }
    await expect(deliverMuseBotInstructions(input, root)).rejects.toThrow(
      'require an Orca bot home outside Git'
    )
    expect(await readFile(rules, 'utf8')).toBe(updated)

    const userRules = join(root, 'user-rules.md')
    await writeFile(userRules, 'Leave these rules alone.')
    await rm(rules)
    await symlink(userRules, rules)
    await expect(deliverMuseBotInstructions(input, botsRoot)).rejects.toThrow(
      'could not write standing instructions to AGENTS.md'
    )
    expect(await readFile(userRules, 'utf8')).toBe('Leave these rules alone.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
