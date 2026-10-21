import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapPosixHookCommand, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'
import { getManagedCommand, KimiHookService } from './hook-service'
import { buildManagedKimiHooksBlock, KIMI_HOOK_EVENTS } from './kimi-hook-config-toml'

// Why: getSharedManagedScriptPath() writes the managed script under
// homedir()/.orca, and getKimiHome() honors KIMI_CODE_HOME. Point both at a
// temp dir so the local install/remove cycle never touches the real ~/.orca or
// ~/.kimi-code. os.homedir() resolves HOME on POSIX and USERPROFILE on Windows.
let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kimi-hook-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.USERPROFILE = home
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalKimiHome === undefined) {
    delete process.env.KIMI_CODE_HOME
  } else {
    process.env.KIMI_CODE_HOME = originalKimiHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.kimi-code', 'config.toml')
const scriptPath = (fileName = 'kimi-hook.sh'): string =>
  join(home, '.orca', 'agent-hooks', fileName)
const supportsPosixFileModes = process.platform !== 'win32'

describe('KimiHookService', () => {
  it('reports not_installed before install', () => {
    expect(new KimiHookService().getStatus().state).toBe('not_installed')
  })

  // Why: Kimi runs hooks through cmd.exe on Windows, where a POSIX `if [ -f ... ]` command
  // fails before it ever reaches the script, so no status event was ever posted.
  describe('on Windows', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('registers the .cmd by bare forward-slash path, else the encoded launcher', () => {
      expect(getManagedCommand('C:\\Users\\alice\\.orca\\agent-hooks\\kimi-hook.cmd')).toBe(
        'C:/Users/alice/.orca/agent-hooks/kimi-hook.cmd'
      )
      const spacedPath = 'C:\\Users\\Bob Smith\\.orca\\agent-hooks\\kimi-hook.cmd'
      expect(getManagedCommand(spacedPath)).toBe(wrapWindowsHookCommand(spacedPath))
    })

    it('installs a curl .cmd script and registers it', () => {
      expect(new KimiHookService().install().state).toBe('installed')

      const command = getManagedCommand(scriptPath('kimi-hook.cmd'))
      expect(readFileSync(configPath(), 'utf-8')).toContain(buildManagedKimiHooksBlock(command))
      const script = readFileSync(scriptPath('kimi-hook.cmd'), 'utf-8')
      expect(script.startsWith('@echo off\r\n')).toBe(true)
      expect(script).toContain('"%SystemRoot%\\System32\\curl.exe"')
      expect(script).toContain('/hook/kimi')
      expect(new KimiHookService().getStatus().state).toBe('installed')
    })

    it('replaces the pre-fix .sh entry on the next install', () => {
      mkdirSync(join(home, '.kimi-code'), { recursive: true })
      const userConfig = 'default_model = "kimi-k2.6"\n'
      // Exactly what the pre-fix installer registered on Windows.
      const legacyCommand = wrapPosixHookCommand(scriptPath().replaceAll('\\', '/'))
      writeFileSync(configPath(), `${userConfig}\n${buildManagedKimiHooksBlock(legacyCommand)}\n`)

      const service = new KimiHookService()
      // The stale entry is still Orca's, so status must not claim nothing is installed.
      expect(service.getStatus().state).toBe('installed')
      expect(service.install().state).toBe('installed')

      const migrated = readFileSync(configPath(), 'utf-8')
      expect(migrated).not.toContain('kimi-hook.sh')
      expect(migrated).toContain(
        buildManagedKimiHooksBlock(getManagedCommand(scriptPath('kimi-hook.cmd')))
      )
      expect((migrated.match(/^\[\[hooks\]\]$/gm) ?? []).length).toBe(KIMI_HOOK_EVENTS.length)

      service.remove()
      expect(readFileSync(configPath(), 'utf-8')).toBe(userConfig)
    })
  })

  it.skipIf(process.platform === 'win32')(
    'installs the managed hooks block and the managed script',
    () => {
      const status = new KimiHookService().install()
      expect(status.state).toBe('installed')
      expect(status.managedHooksPresent).toBe(true)

      const config = readFileSync(configPath(), 'utf-8')
      for (const event of KIMI_HOOK_EVENTS) {
        expect(config).toContain(`event = "${event}"`)
      }
      // The managed script must exist and POST to the Kimi hook endpoint.
      const script = readFileSync(scriptPath(), 'utf-8')
      expect(script).toContain('/hook/kimi')
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
      // The command Kimi runs points at the managed script via sh.
      expect(config).toContain('agent-hooks/kimi-hook.sh')
    }
  )

  it('keeps user config when installing, then restores it on remove', () => {
    const dir = join(home, '.kimi-code')
    mkdirSync(dir, { recursive: true })
    // Pre-existing user config with their own provider.
    const userConfig =
      'default_model = "kimi-k2.6"\n\n[providers."mine"]\ntype = "openai"\napi_key = "sk-secret"\n'
    writeFileSync(configPath(), userConfig)

    const service = new KimiHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('api_key = "sk-secret"')
    expect(installed).toContain('default_model = "kimi-k2.6"')

    // Reinstall must not duplicate the managed block.
    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const afterRemove = readFileSync(configPath(), 'utf-8')
    expect(afterRemove).toBe(userConfig)
  })

  it.skipIf(!supportsPosixFileModes)(
    'preserves an existing config mode while installing and removing hooks',
    () => {
      mkdirSync(join(home, '.kimi-code'), { recursive: true })
      writeFileSync(configPath(), 'api_key = "sk-secret"\n')
      const existingMode = 0o640
      chmodSync(configPath(), existingMode)

      const service = new KimiHookService()
      const originalUmask = process.umask(0o077)
      try {
        service.install()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
        expect(statSync(`${configPath()}.bak`).mode & 0o777).toBe(existingMode)
        expect(
          readdirSync(join(home, '.kimi-code')).filter((name) => name.endsWith('.tmp'))
        ).toEqual([])

        service.remove()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
      } finally {
        process.umask(originalUmask)
      }
    }
  )

  it.skipIf(!supportsPosixFileModes)('creates a new config with an owner-only mode', () => {
    const originalUmask = process.umask(0o022)
    try {
      new KimiHookService().install()

      expect(statSync(configPath()).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(originalUmask)
    }
  })
})
