import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import verifier from './verify-packaged-filesystem-host-entry.cjs'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const {
  assertPackagedFilesystemHostEntryExists,
  buildPackagedFilesystemHostSelfTestEnv,
  verifyPackagedFilesystemHostEntryBoots
} = verifier

describe('packaged filesystem host entry verification', () => {
  const roots = []

  // Why here and not in electron-builder-config.test.mjs: fork() cannot execute from inside an
  // asar, so this unpack rule is the precondition for every boot assertion below.
  it('unpacks the plain-Node filesystem host entry', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/main/filesystem-host-entry.js'])
    )
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createResources(source) {
    const root = mkdtempSync(join(tmpdir(), 'orca-packaged-filesystem-host-'))
    roots.push(root)
    const entry = join(root, 'app.asar.unpacked', 'out', 'main', 'filesystem-host-entry.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, source)
    return root
  }

  it('fails when the unpacked entry is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-packaged-filesystem-host-missing-'))
    roots.push(root)
    expect(() => assertPackagedFilesystemHostEntryExists(root)).toThrow(/missing unpacked entry/)
  })

  it('boots the real packaged-layout entry under plain Node', () => {
    const resources = createResources(
      `process.stdout.write(JSON.stringify({ protocolVersion: 1 }) + '\\n')\n`
    )
    expect(() => verifyPackagedFilesystemHostEntryBoots(resources)).not.toThrow()
  })

  it('keeps only Windows loader roots in the Windows self-test environment', () => {
    expect(
      buildPackagedFilesystemHostSelfTestEnv(
        { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Tools' },
        'win32'
      )
    ).toEqual({ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' })
  })

  it('rejects an entry that loads but misses the protocol self-test', () => {
    const resources = createResources(`process.stdout.write('wrong\\n')\n`)
    expect(() => verifyPackagedFilesystemHostEntryBoots(resources)).toThrow(/self-test failed/)
  })
})
