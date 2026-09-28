import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { buildUnixDevLauncher, extractManagedUnixLauncherTarget } from './cli-dev-launcher'

it.skipIf(process.platform === 'win32' || !process.env.BUN_EXECUTABLE)(
  'ignores workspace Bun configuration while retaining cwd, arguments and Electron app path',
  async () => {
    const runtime = process.env.BUN_EXECUTABLE
    if (!runtime) {
      throw new Error('Missing Bun test runtime')
    }
    const root = await mkdtemp(join(tmpdir(), "orca dev '$ "))
    try {
      const entry = join(root, 'entry.cjs')
      const launcher = join(root, 'orca')
      const electron = join(root, 'electron')
      await writeFile(join(root, 'bunfig.toml'), 'preload = ["./preload.cjs"]\n')
      await writeFile(join(root, 'preload.cjs'), 'process.env.ORCA_CONFIG_PROBE = "loaded"')
      await writeFile(join(root, '.env'), 'ORCA_DOTENV_PROBE=loaded\n')
      await writeFile(
        entry,
        'console.log(JSON.stringify({cwd:process.cwd(),config:process.env.ORCA_CONFIG_PROBE??null,dotenv:process.env.ORCA_DOTENV_PROBE??null,bun:process.versions.bun,app:process.env.ORCA_APP_EXECUTABLE,root:process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT,args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE??null}))'
      )
      await writeFile(launcher, buildUnixDevLauncher(electron, entry, root, runtime), {
        mode: 0o700
      })
      const result = await runProcess({
        program: launcher,
        cwd: root,
        args: ['two words', 'line\nbreak'],
        env: {
          ORCA_APP_EXECUTABLE: '',
          ELECTRON_RUN_AS_NODE: '1',
          BUN_OPTIONS: '--invalid',
          ORCA_BACKGROUND_LAUNCH: '1'
        }
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: await realpath(root),
        config: null,
        dotenv: null,
        bun: expect.any(String),
        app: electron,
        root: '1',
        args: ['two words', 'line\nbreak'],
        nodeMode: null
      })
      await writeFile(
        launcher,
        buildUnixDevLauncher(electron, entry, root, join(root, 'missing')),
        { mode: 0o700 }
      )
      const missing = await runProcess({ program: launcher })
      expect(missing.code).toBe(78)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('recognizes a Bun dev launcher for subsequent managed replacement', () => {
  const entry = '/project/out/cli/index.js'
  expect(
    extractManagedUnixLauncherTarget(buildUnixDevLauncher('/electron', entry, '/profile'))
  ).toBe(entry)
})
