import { runProcess } from '@orca/process-host'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { quotePowerShellLiteral } from '../../../../shared/powershell-native-argument'
import { resolveClaudeResumeLaunch } from './claude-resume'

describe.skipIf(process.platform !== 'win32')('native Windows Claude resume scope', () => {
  it.each([true, false])(
    'binds child argv and restores absent/present parent routing vars (explicit=%s)',
    async (explicit) => {
      const root = await mkdtemp(join(tmpdir(), 'claude-resume-native-'))
      try {
        const capture = join(root, 'child.json')
        const after = join(root, 'after.json')
        await writeFile(
          join(root, 'capture.cjs'),
          `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }))`
        )
        await writeFile(
          join(root, 'claude.cmd'),
          `@"${process.execPath}" "%~dp0capture.cjs" %*\r\n`
        )
        const value = 'a"b & echo INJECTED C:\\dir\\'
        const configDir = explicit ? join(root, "account 'original' $literal") : null
        const launched = await resolveClaudeResumeLaunch({
          command: `claude --resume session --mcp-config ${quotePowerShellLiteral(value)}`,
          env: undefined,
          providerSession: { key: 'session_id', id: 'session' },
          shell: 'powershell',
          target: { runtime: 'host' },
          prepare: async () => ({
            outcome: 'resume',
            configDir,
            userHome: homedir(),
            source: 'capture'
          })
        })
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${root};${process.env.PATH ?? ''}` }
        for (const key of [
          'CLAUDE_CONFIG_DIR',
          'ORCA_CLAUDE_PROFILE_POINTER',
          'ORCA_CLAUDE_INJECTED_CONFIG_DIR',
          'ORCA_CLAUDE_USER_CONFIG_DIR'
        ]) {
          delete env[key]
        }
        if (explicit) {
          env.CLAUDE_CONFIG_DIR = 'parent-config'
          env.ORCA_CLAUDE_PROFILE_POINTER = 'parent-pointer'
        }
        const result = await runProcess({
          program: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `function claude { throw 'shell wrapper must be bypassed' }; ${launched.command}; [IO.File]::WriteAllText(${quotePowerShellLiteral(after)}, (Get-ChildItem Env: | Group-Object -AsHashTable -AsString Name | ConvertTo-Json -Depth 3))`
          ],
          env,
          timeoutMs: 15_000
        })
        expect(result.code, JSON.stringify(result)).toBe(0)
        const child = JSON.parse(await readFile(capture, 'utf8'))
        expect(child.argv).toEqual(['--resume', 'session', '--mcp-config', value])
        expect(child.env.CLAUDE_CONFIG_DIR).toBe(configDir ?? undefined)
        expect(child.env.HOME).toBe(homedir())
        expect(child.env.USERPROFILE).toBe(homedir())
        expect(child.env.ORCA_CLAUDE_PROFILE_POINTER).toBeUndefined()
        const parent = JSON.parse(await readFile(after, 'utf8'))
        if (explicit) {
          expect(parent.CLAUDE_CONFIG_DIR[0].Value).toBe('parent-config')
          expect(parent.ORCA_CLAUDE_PROFILE_POINTER[0].Value).toBe('parent-pointer')
        } else {
          expect(parent.CLAUDE_CONFIG_DIR).toBeUndefined()
          expect(parent.ORCA_CLAUDE_PROFILE_POINTER).toBeUndefined()
        }
        expect(parent.ORCA_CLAUDE_INJECTED_CONFIG_DIR).toBeUndefined()
        expect(parent.ORCA_CLAUDE_USER_CONFIG_DIR).toBeUndefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
