import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  removeGrokHookConfigIfUnchanged,
  writeGrokHookConfigIfUnchanged
} from './grok-hook-config-file'

describe('guarded Grok hook config mutation', () => {
  const dirs: string[] = []

  function makeConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-grok-guard-'))
    dirs.push(dir)
    return join(dir, 'orca-status.json')
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not delete a newer user edit', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    const userEdit =
      '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"user"}]}]}}\n'
    writeFileSync(configPath, installed)
    writeFileSync(configPath, userEdit)

    await expect(removeGrokHookConfigIfUnchanged(configPath, installed)).resolves.toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(userEdit)
  })

  it('treats a newer user deletion as a generation mismatch', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)
    rmSync(configPath)

    await expect(removeGrokHookConfigIfUnchanged(configPath, installed)).resolves.toBe(false)
  })

  it('does not overwrite a newer user edit', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    const userEdit = '{"hooks":{"Notification":[]}}\n'
    writeFileSync(configPath, installed)
    writeFileSync(configPath, userEdit)

    await expect(
      writeGrokHookConfigIfUnchanged(configPath, installed, '{"hooks":{}}\n')
    ).resolves.toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(userEdit)
  })
})
