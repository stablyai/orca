import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { homebrewInstallTap } from './homebrew-install-tap'

let prefix = ''

afterEach(() => rm(prefix, { recursive: true, force: true }))

async function install(keg: string, receipt?: string): Promise<string> {
  prefix = await mkdtemp(join(tmpdir(), 'brew-'))
  const bin = join(prefix, 'Cellar', keg, '2.4.0', 'bin')
  await mkdir(bin, { recursive: true })
  if (receipt) {
    await writeFile(join(prefix, 'Cellar', keg, '2.4.0', 'INSTALL_RECEIPT.json'), receipt)
  }
  return join(bin, keg)
}

describe('homebrewInstallTap', () => {
  it('names the tap that installed a keg whose name another tap may reuse', async () => {
    const core = await install('opencode', '{"source":{"tap":"homebrew/core"}}')
    expect(await homebrewInstallTap(core)).toBe('homebrew/core')
    const tap = await install('opencode', '{"source":{"tap":"anomalyco/tap"}}')
    expect(await homebrewInstallTap(tap)).toBe('anomalyco/tap')
  })

  it('gives no tap for a missing or malformed receipt or a path outside Homebrew', async () => {
    expect(await homebrewInstallTap(await install('opencode'))).toBeNull()
    expect(await homebrewInstallTap(await install('opencode', '{"source":{}}'))).toBeNull()
    expect(await homebrewInstallTap('/Users/x/.opencode/bin/opencode')).toBeNull()
  })
})
