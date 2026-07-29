import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertFdroidMetadataAligned,
  parseFdroidMetadataVersionFields,
  readMobileAndroidAppIdentity,
  syncFdroidMetadataVersions
} from '../../scripts/fdroid-app-identity.mjs'
import {
  ensureExpoBuildFromSource,
  stripReleaseSigningConfig
} from '../../scripts/prepare-fdroid-android-build.mjs'

const validateScriptPath = fileURLToPath(
  new URL('../../scripts/validate-fdroid-metadata.mjs', import.meta.url)
)
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const committedAppConfigPath = join(repoRoot, 'mobile', 'app.json')
const committedMetadataPath = join(repoRoot, 'metadata', 'com.stably.orca.mobile.yml')

let tempDirs: string[] = []

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-fdroid-'))
  tempDirs.push(dir)
  return dir
}

const sampleMetadata = `Categories:
  - Development
License: MIT
SourceCode: https://github.com/stablyai/orca
Repo: https://github.com/stablyai/orca.git
AutoName: Orca

Builds:
  - versionName: 0.0.22
    versionCode: 4
    commit: mobile-android-v0.0.22
    subdir: mobile

CurrentVersion: 0.0.22
CurrentVersionCode: 4
`

describe('fdroid app identity helpers', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true })
    }
    tempDirs = []
  })

  it('reads package id, marketing version, and versionCode from app config', () => {
    const identity = readMobileAndroidAppIdentity({
      expo: {
        name: 'Orca',
        version: '0.0.32',
        android: {
          package: 'com.stably.orca.mobile',
          versionCode: 8
        }
      }
    })

    expect(identity).toEqual({
      packageId: 'com.stably.orca.mobile',
      versionName: '0.0.32',
      versionCode: 8,
      autoName: 'Orca'
    })
  })

  it('rejects invalid versionCode values', () => {
    expect(() =>
      readMobileAndroidAppIdentity({
        expo: {
          version: '1.0.0',
          android: { package: 'com.stably.orca.mobile', versionCode: 0 }
        }
      })
    ).toThrow(/versionCode must be a positive integer/)
  })

  it('parses F-Droid metadata version fields and enforces alignment', () => {
    const identity = readMobileAndroidAppIdentity({
      expo: {
        name: 'Orca',
        version: '0.0.22',
        android: { package: 'com.stably.orca.mobile', versionCode: 4 }
      }
    })
    const fields = parseFdroidMetadataVersionFields(sampleMetadata)
    expect(fields).toEqual({
      versionName: '0.0.22',
      versionCode: 4,
      currentVersion: '0.0.22',
      currentVersionCode: 4
    })
    expect(() => assertFdroidMetadataAligned(identity, fields)).not.toThrow()
  })

  it('syncs metadata version fields and release tag commit to a new app identity', () => {
    const nextIdentity = readMobileAndroidAppIdentity({
      expo: {
        name: 'Orca',
        version: '0.0.32',
        android: { package: 'com.stably.orca.mobile', versionCode: 8 }
      }
    })

    const synced = syncFdroidMetadataVersions(sampleMetadata, nextIdentity)
    expect(synced).toContain('versionName: 0.0.32')
    expect(synced).toContain('versionCode: 8')
    expect(synced).toContain('commit: mobile-android-v0.0.32')
    expect(synced).toContain('CurrentVersion: 0.0.32')
    expect(synced).toContain('CurrentVersionCode: 8')
    assertFdroidMetadataAligned(nextIdentity, parseFdroidMetadataVersionFields(synced))
  })

  it('aligns committed F-Droid metadata with committed mobile/app.json', () => {
    const appConfig = JSON.parse(readFileSync(committedAppConfigPath, 'utf8'))
    const metadataYaml = readFileSync(committedMetadataPath, 'utf8')
    const identity = readMobileAndroidAppIdentity(appConfig)
    const fields = parseFdroidMetadataVersionFields(metadataYaml)

    expect(identity.packageId).toBe('com.stably.orca.mobile')
    expect(metadataYaml).toMatch(/License:\s*MIT/)
    expect(metadataYaml).toMatch(/SourceCode:\s*https:\/\/github\.com\/stablyai\/orca/)
    expect(metadataYaml).toMatch(/Repo:\s*https:\/\/github\.com\/stablyai\/orca\.git/)
    expect(metadataYaml).toContain('pnpm install')
    // Inlined FOSS prep so Builds.commit can pin the release tag (which may predate packaging helpers).
    expect(metadataYaml).toContain('npx expo prebuild --platform android --no-install')
    expect(metadataYaml).toMatch(/sed -i -e '\/signingConfig \/d'/)
    expect(metadataYaml).toContain('buildFromSource')
    expect(metadataYaml).toContain('assembleRelease')
    expect(metadataYaml).toMatch(/scanignore:[\s\S]*hermesc/)
    expect(metadataYaml).toMatch(/scandelete:[\s\S]*node_modules/)
    // Recipe executable prebuild steps must not invoke an in-tree packaging helper
    // that is absent on the pinned release tag (mobile-android-v0.0.32).
    const prebuildSteps =
      metadataYaml.match(/prebuild:\n([\s\S]*?)(?:\n    build:|\n\nAutoUpdateMode:)/)?.[1] ?? ''
    expect(prebuildSteps).not.toMatch(/^\s+-\s+node\s+scripts\//m)
    assertFdroidMetadataAligned(identity, fields)
  })

  it('pinned Builds.commit is a real git rev that has mobile sources without needing packaging helpers', () => {
    const metadataYaml = readFileSync(committedMetadataPath, 'utf8')
    const commitMatch = metadataYaml.match(/^\s+commit:\s*(\S+)\s*$/m)
    expect(commitMatch?.[1]).toBeTruthy()
    const commit = commitMatch![1]

    // Resolve the pinned rev (tag or SHA) and confirm mobile app identity files exist there.
    const resolved = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
      encoding: 'utf8',
      cwd: repoRoot
    }).trim()
    expect(resolved).toMatch(/^[0-9a-f]{40}$/)

    const appJsonAtCommit = execFileSync('git', ['show', `${commit}:mobile/app.json`], {
      encoding: 'utf8',
      cwd: repoRoot
    })
    const identityAtCommit = readMobileAndroidAppIdentity(JSON.parse(appJsonAtCommit))
    expect(identityAtCommit.packageId).toBe('com.stably.orca.mobile')
    expect(identityAtCommit.versionName).toBe(
      parseFdroidMetadataVersionFields(metadataYaml).versionName
    )
    expect(identityAtCommit.versionCode).toBe(
      parseFdroidMetadataVersionFields(metadataYaml).versionCode
    )

    // Packaging helper is optional for the recipe (inlined prebuild); if the recipe ever
    // reintroduces a tree-path script, that path must exist on the pinned commit.
    const prebuildBlock =
      metadataYaml.match(/prebuild:\n([\s\S]*?)(?:\n    build:|\n\nAutoUpdateMode:)/)?.[1] ?? ''
    const scriptRefs = [...prebuildBlock.matchAll(/\b(?:node|bash|sh)\s+(scripts\/\S+)/g)].map(
      (match) => match[1]
    )
    for (const scriptPath of scriptRefs) {
      const result = spawnSync('git', ['cat-file', '-e', `${commit}:mobile/${scriptPath}`], {
        cwd: repoRoot
      })
      expect(result.status, `missing ${scriptPath} on commit ${commit}`).toBe(0)
    }
  })

  it('validate-fdroid-metadata.mjs exits 0 for the committed files', () => {
    const output = execFileSync(process.execPath, [validateScriptPath], {
      encoding: 'utf8',
      env: { ...process.env }
    })
    expect(output).toContain('F-Droid metadata OK: com.stably.orca.mobile')
  })

  it('validate-fdroid-metadata.mjs --write rewrites stale metadata via shipped sync helper', () => {
    const dir = createTempDir()
    const appConfigPath = join(dir, 'app.json')
    const metadataPath = join(dir, 'com.stably.orca.mobile.yml')

    writeFileSync(
      appConfigPath,
      `${JSON.stringify(
        {
          expo: {
            name: 'Orca',
            version: '0.0.32',
            android: { package: 'com.stably.orca.mobile', versionCode: 8 }
          }
        },
        null,
        2
      )}\n`
    )
    writeFileSync(metadataPath, sampleMetadata)

    const output = execFileSync(process.execPath, [validateScriptPath, '--write'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOBILE_APP_CONFIG_PATH: appConfigPath,
        FDROID_METADATA_PATH: metadataPath
      }
    })

    expect(output).toContain('0.0.32 (8)')
    const rewritten = readFileSync(metadataPath, 'utf8')
    expect(rewritten).toContain('versionName: 0.0.32')
    expect(rewritten).toContain('versionCode: 8')
    expect(rewritten).toContain('commit: mobile-android-v0.0.32')
  })

  it('validate-fdroid-metadata.mjs fails when metadata lags app.json', () => {
    const dir = createTempDir()
    const appConfigPath = join(dir, 'app.json')
    const metadataPath = join(dir, 'com.stably.orca.mobile.yml')

    writeFileSync(
      appConfigPath,
      `${JSON.stringify(
        {
          expo: {
            name: 'Orca',
            version: '0.0.32',
            android: { package: 'com.stably.orca.mobile', versionCode: 8 }
          }
        },
        null,
        2
      )}\n`
    )
    writeFileSync(metadataPath, sampleMetadata)

    const result = spawnSync(process.execPath, [validateScriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOBILE_APP_CONFIG_PATH: appConfigPath,
        FDROID_METADATA_PATH: metadataPath
      }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('out of sync')
  })
})

describe('prepare-fdroid-android-build helpers', () => {
  it('enables expo autolinking buildFromSource for FOSS builders', () => {
    const next = ensureExpoBuildFromSource({ name: 'orca-mobile', version: '0.0.1' })
    expect(next.expo.autolinking.android.buildFromSource).toEqual(['.*'])
  })

  it('strips signingConfig lines so F-Droid can re-sign', () => {
    const gradle = `
android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`
    const stripped = stripReleaseSigningConfig(gradle)
    expect(stripped).not.toMatch(/signingConfig/)
    expect(stripped).toContain('minifyEnabled false')
  })
})
