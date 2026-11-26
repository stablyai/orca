import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { HermesHookService } from './hook-service'
import { HERMES_PLUGIN_NAME } from './hermes-managed-plugin-source'

function createMemorySftp(
  files: Map<string, string>,
  hooks?: { onWriteFile?: (path: string) => void }
): SFTPWrapper {
  const enoent = (path: string): Error & { code: number } =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: 2 })

  const sftp = {
    readFile(path: string, _encoding: unknown, cb: (err: Error | null, data?: string) => void) {
      const value = files.get(path)
      if (value === undefined) {
        cb(enoent(path))
        return
      }
      cb(null, value)
    },
    writeFile(path: string, content: string, _options: unknown, cb: (err: Error | null) => void) {
      files.set(path, content)
      hooks?.onWriteFile?.(path)
      cb(null)
    },
    stat(path: string, cb: (err: Error | null, stats?: { mode: number }) => void) {
      if (files.has(path)) {
        cb(null, { mode: 0o100600 })
        return
      }
      const prefix = path.endsWith('/') ? path : `${path}/`
      if (path === '/' || [...files.keys()].some((key) => key.startsWith(prefix))) {
        cb(null, { mode: 0o040755 })
        return
      }
      cb(enoent(path))
    },
    ext_openssh_rename(src: string, dst: string, cb: (err: Error | null) => void) {
      const value = files.get(src)
      if (value === undefined) {
        cb(enoent(src))
        return
      }
      files.delete(src)
      files.set(dst, value)
      cb(null)
    },
    rename(src: string, dst: string, cb: (err: Error | null) => void) {
      sftp.ext_openssh_rename(src, dst, cb)
    },
    unlink(path: string, cb: (err: Error | null) => void) {
      if (!files.delete(path)) {
        cb(enoent(path))
        return
      }
      cb(null)
    },
    chmod(_path: string, _mode: number, cb: (err: Error | null) => void) {
      cb(null)
    },
    readdir(path: string, cb: (err: Error | null, entries?: { filename: string }[]) => void) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) {
          continue
        }
        const rest = key.slice(prefix.length)
        const first = rest.split('/')[0]
        if (first) {
          names.add(first)
        }
      }
      if (names.size === 0) {
        cb(enoent(path))
        return
      }
      cb(
        null,
        [...names].map((filename) => ({ filename }))
      )
    },
    mkdir(_path: string, cb: (err: Error | null) => void) {
      cb(null)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: in-memory test double implements every SFTPWrapper method used by remote hook installation
  return sftp as unknown as SFTPWrapper
}

describe('HermesHookService', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const tempDirs: string[] = []

  const makeTempHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-hook-'))
    tempDirs.push(dir)
    process.env.HERMES_HOME = dir
    return dir
  }

  afterEach(() => {
    if (originalHermesHome === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = originalHermesHome
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['__init__.py', 'plugin.yaml'])(
    'preserves an existing unmanaged local %s instead of overwriting it',
    (fileName) => {
      const home = makeTempHome()
      const configPath = join(home, 'config.yaml')
      const pluginDir = join(home, 'plugins', HERMES_PLUGIN_NAME)
      const originalConfig = 'plugins:\nmodel: "001"\n'
      const userContent = '# user-owned plugin file\n'
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(configPath, originalConfig, 'utf-8')
      writeFileSync(join(pluginDir, fileName), userContent, 'utf-8')

      const service = new HermesHookService()
      const status = service.install()

      expect(status.state).toBe('partial')
      expect(status.managedHooksPresent).toBe(false)
      expect(status.detail).toContain('not Orca-managed')
      expect(readFileSync(join(pluginDir, fileName), 'utf-8')).toBe(userContent)
      const sibling = fileName === '__init__.py' ? 'plugin.yaml' : '__init__.py'
      expect(existsSync(join(pluginDir, sibling))).toBe(false)
      expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig)
    }
  )

  it('preserves an existing unmanaged remote plugin file instead of overwriting it', async () => {
    const remoteHome = '/home/user'
    const configPath = `${remoteHome}/.hermes/config.yaml`
    const initPath = `${remoteHome}/.hermes/plugins/${HERMES_PLUGIN_NAME}/__init__.py`
    const originalConfig = 'plugins:\nmodel: "001"\n'
    const userInit = '# custom user plugin\n'
    const files = new Map<string, string>([
      [configPath, originalConfig],
      [initPath, userInit]
    ])

    const service = new HermesHookService()
    const status = await service.installRemote(createMemorySftp(files), remoteHome)

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(false)
    expect(status.detail).toContain('not Orca-managed')
    expect(files.get(initPath)).toBe(userInit)
    expect(files.get(configPath)).toBe(originalConfig)
  })

  it('redoes remote config edits when config.yaml changes after the initial read', async () => {
    const remoteHome = '/home/user'
    const configPath = `${remoteHome}/.hermes/config.yaml`
    const files = new Map<string, string>([[configPath, 'plugins:\nmodel: "old"\n']])
    let injectedSave = false
    const sftp = createMemorySftp(files, {
      onWriteFile(path) {
        if (!injectedSave && path.includes('/plugins/')) {
          injectedSave = true
          files.set(configPath, 'plugins:\nmodel: "new"\n')
        }
      }
    })

    const service = new HermesHookService()
    const status = await service.installRemote(sftp, remoteHome)

    expect(status.state).toBe('installed')
    expect(injectedSave).toBe(true)
    expect(parse(files.get(configPath) ?? '')).toMatchObject({
      model: 'new',
      plugins: { enabled: expect.arrayContaining([HERMES_PLUGIN_NAME]) }
    })
  })

  it('reports contention without clobbering when remote config.yaml keeps changing', async () => {
    const remoteHome = '/home/user'
    const configPath = `${remoteHome}/.hermes/config.yaml`
    const files = new Map<string, string>([[configPath, 'plugins:\nmodel: "v0"\n']])
    let version = 0
    const sftp = createMemorySftp(files, {
      onWriteFile(path) {
        if (path.startsWith(`${remoteHome}/.hermes/.`) && path.endsWith('.tmp')) {
          version += 1
          files.set(configPath, `plugins:\nmodel: "v${version}"\n`)
        }
      }
    })

    const service = new HermesHookService()
    const status = await service.installRemote(sftp, remoteHome)

    expect(status.state).toBe('error')
    expect(status.detail).toContain('kept changing')
    expect(status.managedHooksPresent).toBe(true)
    expect(files.get(configPath)).toBe(`plugins:\nmodel: "v${version}"\n`)
  })
})
