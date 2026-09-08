import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { PiTitlebarExtensionService } from './titlebar-extension-service'
import { getPiTitlebarExtensionSource, ORCA_PI_EXTENSION_FILE } from './titlebar-extension-source'

describe('managed titlebar lifetime source installation', () => {
  it.each(['pi', 'omp'] as const)(
    'updates the installed %s extension byte-for-byte and preserves user files',
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-titlebar-lifetime-'))
      try {
        const agent = join(root, 'agent')
        const extensions = join(agent, 'extensions')
        const target = join(extensions, ORCA_PI_EXTENSION_FILE)
        mkdirSync(extensions, { recursive: true })
        installFakeAppEnvironment({ getPath: () => join(root, 'userdata') })
        writeFileSync(target, '// @orca-managed-pi-extension\n// previous generation')
        const service = new PiTitlebarExtensionService()
        service.buildPtyEnv('synthetic-pane', agent, kind)
        expect(readFileSync(target, 'utf8')).toBe(
          `// @orca-managed-pi-extension\n${getPiTitlebarExtensionSource()}`
        )
        writeFileSync(target, '// user-owned titlebar')
        service.buildPtyEnv('synthetic-pane', agent, kind)
        expect(readFileSync(target, 'utf8')).toBe('// user-owned titlebar')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
