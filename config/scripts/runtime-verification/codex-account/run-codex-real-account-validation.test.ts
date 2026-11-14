import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cleanupPaths: string[] = []
const validationModuleUrl = pathToFileURL(
  path.resolve(
    'config/scripts/runtime-verification/codex-account/run-codex-real-account-validation.mjs'
  )
).href

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) => rm(cleanupPath, { recursive: true }))
  )
})

describe('Codex real-account validation harness', () => {
  it('records only fingerprints for system-default and managed auth', async () => {
    const { layout, snapshot } = runValidationModule<{
      layout: { tempRoot: string }
      snapshot: {
        throwawayCodex: { auth: { sha256?: string } }
        managedHomes: { auth: { sha256?: string } }[]
      }
    }>(
      `
        import path from 'node:path'
        import { mkdir, writeFile } from 'node:fs/promises'
        const { createValidationLayout, snapshotValidationState } = await import(process.argv[1])
        const layout = await createValidationLayout({ primaryHome: process.argv[2] })
        const systemHome = path.join(layout.homeDir, '.codex')
        const managedHome = path.join(layout.userDataDir, 'codex-accounts', 'account-1', 'home')
        await Promise.all([
          mkdir(systemHome, { recursive: true }),
          mkdir(managedHome, { recursive: true })
        ])
        await writeFile(path.join(systemHome, 'auth.json'), '{"refresh_token":"system-secret"}\\n')
        await writeFile(path.join(managedHome, 'auth.json'), '{"refresh_token":"never-report-me"}\\n')
        console.log(JSON.stringify({ layout, snapshot: await snapshotValidationState(layout) }))
      `,
      [path.join(os.tmpdir(), 'orca-primary-home-sentinel')]
    )
    cleanupPaths.push(layout.tempRoot)

    expect(snapshot.throwawayCodex.auth.sha256).toBe(
      '31f4bbbaf084b1f0219648dd7be0161d92207bf3361edec55c7b5c81ecefa14c'
    )
    expect(snapshot.managedHomes[0].auth.sha256).toBe(
      '0ceece50035d895227dec8d4c57df22e1a666cce3d8f56687b212d64d5d82ab6'
    )
    expect(JSON.stringify(snapshot)).not.toContain('system-secret')
    expect(JSON.stringify(snapshot)).not.toContain('never-report-me')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked temp parent that resolves inside the primary home',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'orca-symlink-guard-'))
      cleanupPaths.push(root)
      const primaryHome = path.join(root, 'primary-home')
      const insidePrimary = path.join(primaryHome, 'nested-temp')
      const link = path.join(root, 'temp-link')
      await mkdir(insidePrimary, { recursive: true })
      await symlink(insidePrimary, link)

      const { error } = runValidationModule<{ error: string | null }>(
        `
        const { createValidationLayout } = await import(process.argv[1])
        try {
          const layout = await createValidationLayout({ primaryHome: process.argv[2] })
          console.log(JSON.stringify({ error: null, layout }))
        } catch (caught) {
          console.log(JSON.stringify({ error: caught.message }))
        }
      `,
        [primaryHome],
        { ORCA_CODEX_VALIDATION_TEMP_PARENT: link }
      )

      expect(error).toContain('Refusing to place the disposable validation root')
    }
  )

  it('refuses a temp parent inside the primary home and points at the overrides', () => {
    // Why: matches Windows, where the default %TEMP% lives inside %USERPROFILE%.
    const { error } = runValidationModule<{ error: string | null }>(
      `
        const { createValidationLayout } = await import(process.argv[1])
        try {
          const layout = await createValidationLayout({ primaryHome: process.argv[2] })
          console.log(JSON.stringify({ error: null, layout }))
        } catch (caught) {
          console.log(JSON.stringify({ error: caught.message }))
        }
      `,
      [os.tmpdir()]
    )

    expect(error).toContain('Refusing to place the disposable validation root')
    expect(error).toContain('--temp-parent')
    expect(error).toContain('ORCA_CODEX_VALIDATION_TEMP_PARENT')
  })
})

function runValidationModule<T>(source: string, args: string[], env?: Record<string, string>): T {
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source, validationModuleUrl, ...args],
    {
      encoding: 'utf8',
      // Why: an ambient temp-parent override must not redirect unrelated cases.
      env: { ...process.env, ORCA_CODEX_VALIDATION_TEMP_PARENT: '', ...env }
    }
  )
  return JSON.parse(stdout.trim()) as T
}
