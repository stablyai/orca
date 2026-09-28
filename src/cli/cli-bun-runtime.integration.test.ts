import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'runs the compiled CLI under Bun without a host Node or an existing home',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const home = await mkdtemp(join(tmpdir(), 'orca-bun-cli-'))
    const entry = join(process.cwd(), 'out', 'cli', 'index.js')
    const run = (args: string[]) =>
      runProcess({
        program: runtime,
        args: [entry, ...args],
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, '.codex'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          ORCA_USER_DATA_PATH: join(home, 'profile'),
          ORCA_BACKGROUND_LAUNCH: '1',
          NODE_OPTIONS: '',
          NODE_REPL_EXTERNAL_MODULE: '',
          PATH: ''
        },
        timeoutMs: 15_000
      })
    try {
      const help = await run(['--help'])
      expect(help.code, help.stderr).toBe(0)
      expect(help.stdout).toContain('Usage')
      const list = await run(['skills', 'list', '--json'])
      expect(list.code, list.stderr).toBe(0)
      expect(JSON.parse(list.stdout).topics).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'orca-cli' })])
      )
      const guide = await run(['skills', 'get', 'orca-cli'])
      expect(guide.code, guide.stderr).toBe(0)
      expect(guide.stdout).toContain('name: orca-cli')
      const invalid = await run(['not-an-orca-command'])
      expect(invalid.code).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
  30_000
)
