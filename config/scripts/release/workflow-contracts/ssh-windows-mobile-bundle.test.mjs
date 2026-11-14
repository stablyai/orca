import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { writeMobileWebBundleFixtureTree } from '../../build/mobile-web-app/mobile-web-bundle-fixture-tree.mjs'

const workflow = parse(readFileSync('.github/workflows/ssh-windows-hosts.yml', 'utf8'))
const consumer = workflow.jobs.hosts
const verify = consumer.steps.find(
  (step) => step.name === 'Verify the mobile bundle before staging it'
)

it.skipIf(process.platform === 'win32')(
  'executes the consumer verifier without mobile dependencies and rejects corrupt assets',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ssh-mobile-bundle-'))
    try {
      mkdirSync(join(directory, 'config', 'scripts'), { recursive: true })
      for (const file of [
        'config/dark-build-switches.cjs',
        'config/scripts/desktop-distribution/runtime-verification/verify-packaged-mobile-web-bundle.cjs'
      ]) {
        mkdirSync(dirname(join(directory, file)), { recursive: true })
        copyFileSync(file, join(directory, file))
      }
      const bundleDir = join(directory, 'out', 'mobile-web')
      await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
      const execute = () =>
        runProcessSync({
          program: 'bash',
          args: ['-e', '-o', 'pipefail', '-c', verify.run],
          cwd: directory
        })
      expect(execute().code).toBe(0)
      const indexPath = join(bundleDir, 'index.html')
      writeFileSync(indexPath, 'x'.repeat(readFileSync(indexPath).length))
      const corrupted = execute()
      expect(corrupted.code).not.toBe(0)
      expect(corrupted.stderr).toContain('hashes to')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
