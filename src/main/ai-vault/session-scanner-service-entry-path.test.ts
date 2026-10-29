import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveAiVaultServiceEntryPath,
  resolveAiVaultServiceEntryPathWithoutApp
} from './session-scanner-service-entry-path'

describe('resolveAiVaultServiceEntryPath', () => {
  it('uses the adjacent electron-vite output when present', () => {
    const outMain = join(process.cwd(), 'out', 'main')
    const adjacent = join(outMain, 'session-scanner-service-entry.js')

    expect(resolveAiVaultServiceEntryPath(outMain, false, (path) => path === adjacent)).toBe(
      adjacent
    )
  })

  it('uses the nested output from a project root', () => {
    expect(resolveAiVaultServiceEntryPath(process.cwd(), false, () => false)).toBe(
      join(process.cwd(), 'out', 'main', 'session-scanner-service-entry.js')
    )
  })

  it('uses app.asar.unpacked for packaged Electron', () => {
    const appPath = join('C:', 'Orca', 'resources', 'app.asar')

    expect(resolveAiVaultServiceEntryPath(appPath, true)).toBe(
      join(
        'C:',
        'Orca',
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'session-scanner-service-entry.js'
      )
    )
  })

  it('uses the entry beside the bundle on a packaged host without an asar', () => {
    const orcadRoot = join('/opt', 'orcad', '1.0.0')
    const adjacent = join(orcadRoot, 'session-scanner-service-entry.js')

    expect(resolveAiVaultServiceEntryPath(orcadRoot, true, (path) => path === adjacent)).toBe(
      adjacent
    )
  })

  it('never forks an adjacent decoy from inside app.asar', () => {
    const appPath = join('/opt', 'Orca', 'resources', 'app.asar')

    expect(resolveAiVaultServiceEntryPath(appPath, true, () => true)).toBe(
      join(
        '/opt',
        'Orca',
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'session-scanner-service-entry.js'
      )
    )
  })

  it('uses resourcesPath from packaged Electron-as-Node runtimes', () => {
    const resourcesPath = join('Applications', 'Orca.app', 'Contents', 'Resources')
    const entry = join(
      resourcesPath,
      'app.asar.unpacked',
      'out',
      'main',
      'session-scanner-service-entry.js'
    )

    expect(
      resolveAiVaultServiceEntryPathWithoutApp(
        '/unrelated/cwd',
        resourcesPath,
        (path) => path === entry
      )
    ).toBe(entry)
  })
})
