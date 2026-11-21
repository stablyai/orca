import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeOrcadFullVersion } from '../../../../config/scripts/orcad-distribution/server-bundle/orcad-artifact-version.mjs'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_ENTRY_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames,
  orcadMobileWebAssetFilenames
} from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import { listOrcadArtifactFilenames, readOrcadArtifactIdentity } from './orcad-artifact-identity'

const TARGET = 'linux-x64-glibc'
const BROWSER = 'agent-browser-linux-x64'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeArtifact(directory: string, filename: string, contents: string): void {
  const path = join(directory, filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/** Required slot bytes only. The optional browser is added by the caller. */
function writeRequiredSlot(directory: string): void {
  const manifest = JSON.stringify({ assets: [{ path: 'index.html' }] })
  for (const filename of orcadArtifactFilenames(TARGET, orcadMobileWebAssetFilenames(manifest))) {
    if (filename === ORCAD_MOBILE_WEB_MANIFEST || filename === ORCAD_SERVER_TARGET_FILENAME) {
      continue
    }
    writeArtifact(directory, filename, `${filename}\n`)
  }
  writeArtifact(directory, ORCAD_SERVER_TARGET_FILENAME, `${TARGET}\n`)
  writeArtifact(directory, ORCAD_MOBILE_WEB_MANIFEST, manifest)
}

describe('optional agent-browser install id', () => {
  it('keeps the same build id when only the optional browser binary is present', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orcad-id-plain-'))
    dirs.push(plain)
    writeRequiredSlot(plain)
    const withBrowser = mkdtempSync(join(tmpdir(), 'orcad-id-browser-'))
    dirs.push(withBrowser)
    cpSync(plain, withBrowser, { recursive: true })
    writeArtifact(withBrowser, BROWSER, 'browser-bytes')

    const packagedPlain = computeOrcadFullVersion(plain, {
      target: TARGET,
      agentBrowserFilename: BROWSER
    })
    const packagedWithBrowser = computeOrcadFullVersion(withBrowser, {
      target: TARGET,
      agentBrowserFilename: BROWSER
    })
    expect(packagedWithBrowser).toBe(packagedPlain)
    expect(await readOrcadArtifactIdentity(withBrowser)).toBe(
      await readOrcadArtifactIdentity(plain)
    )
    expect(await listOrcadArtifactFilenames(withBrowser)).toContain(BROWSER)
    expect(await listOrcadArtifactFilenames(plain)).not.toContain(BROWSER)
  })

  it('changes the build id when a required server file changes', () => {
    const left = mkdtempSync(join(tmpdir(), 'orcad-id-left-'))
    const right = mkdtempSync(join(tmpdir(), 'orcad-id-right-'))
    dirs.push(left, right)
    writeRequiredSlot(left)
    writeRequiredSlot(right)
    writeArtifact(right, ORCAD_SERVER_ENTRY_FILENAME, 'different-server\n')

    expect(
      computeOrcadFullVersion(left, { target: TARGET, agentBrowserFilename: BROWSER })
    ).not.toBe(computeOrcadFullVersion(right, { target: TARGET, agentBrowserFilename: BROWSER }))
  })
})
