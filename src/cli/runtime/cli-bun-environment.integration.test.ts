import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)('does not load project dotenv files when launching the CLI', async () => {
  if (!runtime) {
    throw new Error('BUN_EXECUTABLE is required')
  }
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-environment-'))
  try {
    const launcher = join(root, 'launcher.cjs')
    const entry = join(root, 'entry.cjs')
    await build({
      stdin: {
        contents:
          "import { launchBunCli } from './src/cli/runtime/cli-bun-launcher'; launchBunCli(process.argv[2], process.argv[3], [])",
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: launcher
    })
    await writeFile(
      join(root, '.env'),
      'ORCA_USER_DATA_PATH=foreign-profile\nORCA_CLI_CWD=foreign-workspace\n'
    )
    await writeFile(
      entry,
      'console.log(JSON.stringify({profile:process.env.ORCA_USER_DATA_PATH??null,cwd:process.env.ORCA_CLI_CWD??null}));process.disconnect?.()'
    )
    const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    delete env.ORCA_USER_DATA_PATH
    delete env.ORCA_CLI_CWD
    const result = await runProcess({
      program: process.execPath,
      args: [launcher, runtime, entry],
      cwd: root,
      env,
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({ profile: null, cwd: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
