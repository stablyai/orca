import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cleanupPaths: string[] = []
const validationModuleUrl = pathToFileURL(
  path.resolve('config/scripts/run-codex-real-account-validation.mjs')
).href

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) => rm(cleanupPath, { recursive: true }))
  )
})

describe('Codex real-account validation harness', () => {
  it('forces home and Codex routing variables after stripping ambient values', async () => {
    const primaryHome = path.join(os.tmpdir(), 'orca-primary-home-sentinel')
    const { layout, env } = runValidationModule<{
      layout: { tempRoot: string; homeDir: string }
      env: Record<string, string | undefined>
    }>(
      `
        const { createValidationEnv, createValidationLayout } = await import(process.argv[1])
        const primaryHome = process.argv[2]
        const layout = await createValidationLayout({ primaryHome })
        const env = createValidationEnv({
          HOME: primaryHome,
          USERPROFILE: primaryHome,
          CODEX_HOME: '/unsafe/codex',
          ORCA_CODEX_HOME: '/unsafe/orca-codex',
          ZDOTDIR: '/unsafe/zsh',
          SAFE_VALUE: 'preserved'
        }, layout)
        console.log(JSON.stringify({ layout, env }))
      `,
      [primaryHome]
    )
    cleanupPaths.push(layout.tempRoot)

    expect(env.HOME).toBe(layout.homeDir)
    expect(env.USERPROFILE).toBe(layout.homeDir)
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
    expect(env.ZDOTDIR).toBeUndefined()
    expect(env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME).toBe('1')
    expect(env.SAFE_VALUE).toBe('preserved')
  })

  it('pins the real-home flag off when the system-default lane is disabled', async () => {
    const primaryHome = path.join(os.tmpdir(), 'orca-primary-home-sentinel')
    const { layout, env } = runValidationModule<{
      layout: { tempRoot: string }
      env: Record<string, string | undefined>
    }>(
      `
        const { createValidationEnv, createValidationLayout } = await import(process.argv[1])
        const layout = await createValidationLayout({ primaryHome: process.argv[2] })
        const env = createValidationEnv({}, layout, { systemDefaultRealHome: 'off' })
        console.log(JSON.stringify({ layout, env }))
      `,
      [primaryHome]
    )
    cleanupPaths.push(layout.tempRoot)

    expect(env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME).toBe('0')
  })

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

    expect(snapshot.throwawayCodex.auth.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.managedHomes[0].auth.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('system-secret')
    expect(JSON.stringify(snapshot)).not.toContain('never-report-me')
  })

  it('honors a disposable temp parent override outside the primary home', async () => {
    const tempParent = await mkdtemp(path.join(os.tmpdir(), 'orca-temp-parent-'))
    cleanupPaths.push(tempParent)
    const { layout } = runValidationModule<{ layout: { tempRoot: string } }>(
      `
        const { createValidationLayout } = await import(process.argv[1])
        const layout = await createValidationLayout({ primaryHome: process.argv[2] })
        console.log(JSON.stringify({ layout }))
      `,
      [path.join(os.tmpdir(), 'orca-primary-home-sentinel')],
      { ORCA_CODEX_VALIDATION_TEMP_PARENT: tempParent }
    )

    expect(path.dirname(layout.tempRoot)).toBe(tempParent)
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

  it('builds via process.execPath and the repo-local electron-vite entry, not npx', () => {
    // Why: raw `npx` resolves to a .cmd shim on Windows that execFileSync cannot
    // launch (ENOENT), so the build command must use the current Node binary and
    // the repository-local electron-vite JS entry to stay cross-platform.
    const { command, args, entry } = runValidationModule<{
      command: string
      args: string[]
      entry: string
    }>(
      `
        import path from 'node:path'
        const { resolveElectronViteBuildCommand } = await import(process.argv[1])
        const repoRoot = process.argv[2]
        const result = resolveElectronViteBuildCommand(repoRoot)
        const entry = path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
        console.log(JSON.stringify({ ...result, entry }))
      `,
      [path.resolve('.')]
    )

    expect(command).toBe(process.execPath)
    expect(command).not.toBe('npx')
    expect(args[0]).toBe(entry)
    expect(args.slice(1)).toEqual(['build', '--mode', 'e2e'])
    expect(args).not.toContain('npx')
  })

  it('fails clearly when the repo-local electron-vite entry is unavailable', async () => {
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-no-electron-vite-'))
    cleanupPaths.push(emptyRoot)
    const { error } = runValidationModule<{ error: string | null }>(
      `
        const { resolveElectronViteBuildCommand } = await import(process.argv[1])
        try {
          resolveElectronViteBuildCommand(process.argv[2])
          console.log(JSON.stringify({ error: null }))
        } catch (caught) {
          console.log(JSON.stringify({ error: caught.message }))
        }
      `,
      [emptyRoot]
    )

    expect(error).toContain('electron-vite entry not found')
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
