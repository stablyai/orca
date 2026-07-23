import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_MANAGED_PI_EXTENSION_MARKER,
  PI_MANAGED_EXTENSION_OWNERSHIP_MAX_BYTES,
  isManagedPiExtensionFile
} from './managed-extension-ownership'

const roots: string[] = []

function tempFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-managed-extension-ownership-'))
  roots.push(root)
  const path = join(root, 'orca-agent-status.ts')
  writeFileSync(path, contents)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('managed Pi extension ownership', () => {
  it('accepts a marked file at the exact byte limit', () => {
    const prefix = `// ${ORCA_MANAGED_PI_EXTENSION_MARKER}\n`
    const path = tempFile(
      prefix + 'x'.repeat(PI_MANAGED_EXTENSION_OWNERSHIP_MAX_BYTES - prefix.length)
    )

    expect(isManagedPiExtensionFile(path)).toBe(true)
  })

  it('treats a marked file one byte over the limit as user-owned', () => {
    const prefix = `// ${ORCA_MANAGED_PI_EXTENSION_MARKER}\n`
    const path = tempFile(
      prefix + 'x'.repeat(PI_MANAGED_EXTENSION_OWNERSHIP_MAX_BYTES - prefix.length + 1)
    )

    expect(isManagedPiExtensionFile(path)).toBe(false)
  })

  it('treats missing and unmarked files as user-owned', () => {
    const path = tempFile('user extension')

    expect(isManagedPiExtensionFile(path)).toBe(false)
    expect(isManagedPiExtensionFile(`${path}.missing`)).toBe(false)
  })
})
