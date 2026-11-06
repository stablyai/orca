import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cleanupPaths: string[] = []
const tripwireScriptPath = path.resolve(
  'config/scripts/runtime-verification/codex-account/codex-primary-home-tripwire.mjs'
)
const tripwireModuleUrl = pathToFileURL(tripwireScriptPath).href

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) => rm(cleanupPath, { recursive: true }))
  )
})

async function createPrimaryHome(): Promise<string> {
  const primaryHome = await mkdtemp(path.join(os.tmpdir(), 'orca-codex-tripwire-'))
  cleanupPaths.push(primaryHome)
  await mkdir(path.join(primaryHome, '.codex'))
  return primaryHome
}

describe('Codex primary-home tripwire', () => {
  it('detects a write without reading file contents', async () => {
    const primaryHome = await createPrimaryHome()
    const status = runTripwireModule<{
      clean: boolean
      events: { changedPaths: string[] }[]
    }>(
      `
        import path from 'node:path'
        import { writeFile } from 'node:fs/promises'
        const { startCodexPrimaryHomeTripwire } = await import(process.argv[1])
        const tripwire = await startCodexPrimaryHomeTripwire({
          primaryHome: process.argv[2],
          intervalMs: 25
        })
        await writeFile(path.join(process.argv[2], '.codex', 'hooks.json'), '{"secret":"not-read"}\\n')
        await tripwire.scan()
        console.log(JSON.stringify(await tripwire.stop()))
      `,
      [primaryHome]
    )
    expect(status.clean).toBe(false)
    expect(status.events[0].changedPaths).toContain('hooks.json')
    expect(JSON.stringify(status)).not.toContain('not-read')
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'does not follow symlinks outside the watched home',
    async () => {
      const primaryHome = await createPrimaryHome()
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-codex-tripwire-external-'))
      cleanupPaths.push(externalRoot)
      const externalFile = path.join(externalRoot, 'credential.txt')
      await writeFile(externalFile, 'before')
      await symlink(externalFile, path.join(primaryHome, '.codex', 'linked-credential'))
      const codexHome = path.join(primaryHome, '.codex')
      const before = snapshotCodexHome(codexHome)

      await writeFile(externalFile, 'after-with-a-different-size')
      const after = snapshotCodexHome(codexHome)

      expect(after.digest).toBe(before.digest)
    }
  )
})

function runTripwireModule<T>(source: string, args: string[]): T {
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source, tripwireModuleUrl, ...args],
    { encoding: 'utf8' }
  )
  return JSON.parse(stdout.trim()) as T
}

function snapshotCodexHome(codexHome: string): { digest: string } {
  return runTripwireModule<{ digest: string }>(
    `
      const { snapshotCodexHome } = await import(process.argv[1])
      console.log(JSON.stringify(await snapshotCodexHome(process.argv[2])))
    `,
    [codexHome]
  )
}
