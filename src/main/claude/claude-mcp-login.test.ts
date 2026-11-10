import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loginClaudeMcp } from './claude-mcp-login'

it('runs MCP login in the captured account and directory with a literal server argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-mcp-login-'))
  try {
    const script = join(root, 'fake-claude.cjs')
    const resultPath = join(root, 'invocation.json')
    await writeFile(
      script,
      `
      require('node:fs').writeFileSync(process.env.FIXTURE_RESULT, JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(),
        account: process.env.CLAUDE_CONFIG_DIR
      }));
      console.log('fixture output that must never reach the renderer');
    `
    )
    await loginClaudeMcp(
      {
        pathToClaudeCodeExecutable: process.execPath,
        prefixArgs: [script],
        cwd: root,
        options: {}
      },
      {
        PATH: process.env.PATH ?? '',
        ORCA_BACKGROUND_LAUNCH: '1',
        CLAUDE_CONFIG_DIR: join(root, 'captured-account'),
        FIXTURE_RESULT: resultPath
      },
      '--literal-server',
      new AbortController().signal
    )
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({
      args: ['mcp', 'login', '--', '--literal-server'],
      cwd: await realpath(root),
      account: join(root, 'captured-account')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
