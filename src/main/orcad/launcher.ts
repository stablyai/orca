import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ORCAD_SERVER_ENTRY_FILENAME } from '../../shared/orcad-artifacts'
import { assertOrcadServerRuntime, handoffToBundledOrcad } from './orcad-bundled-runtime'

declare const ORCAD_SERVER_SHA256: string

let loadServer: (() => void) | undefined

try {
  if (!handoffToBundledOrcad()) {
    assertOrcadServerRuntime()
    const entry = realpathSync(process.argv[1] ?? __filename)
    const server = join(dirname(entry), ORCAD_SERVER_ENTRY_FILENAME)
    if (createHash('sha256').update(readFileSync(server)).digest('hex') !== ORCAD_SERVER_SHA256) {
      throw new Error('The Orca server does not match its launcher')
    }
    loadServer = () => createRequire(entry)(server)
  }
} catch (error) {
  console.error('orcad: failed to launch:', error)
  process.exit(78)
}

loadServer?.()
