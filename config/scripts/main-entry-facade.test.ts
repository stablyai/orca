import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import { runProcess } from '@orca/process-host'
import { electronViteConfig } from '../../electron.vite.config'

it('keeps main code and asset paths working after a CLI build replaces its public entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-main-entry-facade-'))
  try {
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
    await writeFile(join(root, 'tracker.ts'), 'export const createTracker = () => ({ count: 0 })')
    await writeFile(
      join(root, 'boot-label.ts'),
      'export const getBootLabel = () => process.env.ORCA_FIXTURE_BOOT_LABEL || "boot"'
    )
    await writeFile(
      join(root, 'late.ts'),
      'import { getBootLabel } from "./boot-label"; export const readLabel = () => getBootLabel()'
    )
    await writeFile(
      join(root, 'controls.ts'),
      'import { createTracker } from "./tracker"; export const getStatus = () => createTracker().count'
    )
    await writeFile(
      join(root, 'main.ts'),
      'import { writeFileSync } from "node:fs"; import { join } from "node:path"; import { getStatus } from "./controls"; import { createTracker } from "./tracker"; import { getBootLabel } from "./boot-label"; import("./late").then(({ readLabel }) => writeFileSync(join(__dirname, "result.json"), JSON.stringify({ status: getStatus(), tracker: createTracker(), directory: __dirname, label: getBootLabel(), lateLabel: readLabel() })))'
    )
    const options = electronViteConfig.main?.build?.rollupOptions
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        ssr: true,
        minify: electronViteConfig.main?.build?.minify,
        rolldownOptions: {
          ...options,
          plugins: [],
          input: { index: join(root, 'main.ts'), controls: join(root, 'controls.ts') }
        }
      }
    })
    // tsc emits public names only, replacing the bundler's entry at this same path.
    await writeFile(join(root, 'dist', 'controls.js'), 'exports.getStatus = () => 0')
    const result = await runProcess({
      program: process.execPath,
      args: [join(root, 'dist', 'index.js')]
    })
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'dist', 'result.json'), 'utf8'))).toEqual({
      status: 0,
      tracker: { count: 0 },
      directory: join(root, 'dist'),
      label: 'boot',
      lateLabel: 'boot'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
