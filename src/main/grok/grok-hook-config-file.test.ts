import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('does not overwrite an edit published after it holds the expected generation', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    const userEdit = '{"hooks":{"Notification":[]}}\n'
    writeFileSync(configPath, installed)

    await expect(
      writeGrokHookConfigIfUnchanged(configPath, installed, '{"hooks":{}}\n', {
        shouldCommit: async () => {
          writeFileSync(configPath, userEdit)
          return true
        }
      })
    ).resolves.toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(userEdit)
  })

  it('does not delete an edit published after it holds the expected generation', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    const userEdit = '{"hooks":{"Notification":[]}}\n'
    writeFileSync(configPath, installed)

    await expect(
      removeGrokHookConfigIfUnchanged(configPath, installed, {
        shouldCommit: async () => {
          writeFileSync(configPath, userEdit)
          return true
        }
      })
    ).resolves.toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(userEdit)
  })

  it('restores the original config when ownership blocks cleanup', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)

    await expect(
      removeGrokHookConfigIfUnchanged(configPath, installed, {
        shouldCommit: async () => false
      })
    ).resolves.toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(installed)
    expect(statSync(configPath).nlink).toBe(1)
  })

  it('keeps the live config in place while the ownership probe is pending', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)
    let finishProbe!: (allowed: boolean) => void
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve
    })
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })

    const cleanup = removeGrokHookConfigIfUnchanged(configPath, installed, {
      beforeHold: async () => {
        probeStarted()
        return await probe
      }
    })
    await started

    expect(readFileSync(configPath, 'utf8')).toBe(installed)
    expect(readdirSync(dirname(configPath))).toEqual(['orca-status.json'])
    finishProbe(false)
    await expect(cleanup).resolves.toBe(false)
  })

  it('preserves the existing file mode on replacement', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)
    chmodSync(configPath, 0o600)

    await expect(
      writeGrokHookConfigIfUnchanged(configPath, installed, '{"hooks":{}}\n')
    ).resolves.toBe(true)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  // Why this is pinned: Grok stats every global hook JSON and refuses to build a sandbox profile
  // for one whose st_nlink != 1, failing the whole session. A publish-by-hard-link swap leaves the
  // config at nlink 2 for the width of the write, so any Grok session starting in that window dies.
  it('never publishes the config through a second hard link', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)

    const linkCounts: number[] = []
    const sampler = setInterval(() => {
      try {
        linkCounts.push(statSync(configPath).nlink)
      } catch {
        /* absent mid-swap is fine; only a second link is not */
      }
    }, 0)
    try {
      for (let i = 0; i < 40; i += 1) {
        const next = `{"hooks":{"SessionStart":[],"n":${i}}}\n`
        await expect(
          writeGrokHookConfigIfUnchanged(configPath, readFileSync(configPath, 'utf8'), next)
        ).resolves.toBe(true)
      }
    } finally {
      clearInterval(sampler)
    }

    expect(linkCounts.length).toBeGreaterThan(0)
    expect(Math.max(...linkCounts)).toBe(1)
    expect(statSync(configPath).nlink).toBe(1)
  })

  it('removes the config and reports the removal', async () => {
    const configPath = makeConfigPath()
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)

    await expect(removeGrokHookConfigIfUnchanged(configPath, installed)).resolves.toBe(true)
    expect(existsSync(configPath)).toBe(false)
  })

  it('leaves no temp file behind after a successful write', async () => {
    const configPath = makeConfigPath()
    const dir = dirname(configPath)
    const installed = '{"hooks":{"SessionStart":[]}}\n'
    writeFileSync(configPath, installed)

    await expect(
      writeGrokHookConfigIfUnchanged(configPath, installed, '{"hooks":{}}\n')
    ).resolves.toBe(true)
    expect(readdirSync(dir)).toEqual(['orca-status.json'])
  })
})
