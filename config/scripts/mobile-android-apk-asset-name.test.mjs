import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const ORCA_APK_NAME = 'orca-app-release.apk'
const GRADLE_APK_NAME = 'app-release.apk'
const RENAME_STEP = 'Name the release APK for Orca'

const workflow = () =>
  parse(readFileSync(join(projectDir, '.github/workflows/mobile-android-release.yml'), 'utf8'))
const steps = () => workflow().jobs['android-build'].steps
const stepNamed = (name) => steps().find((step) => step.name === name)

describe('Orca Android release APK asset name', () => {
  // A GitHub release asset is named after the file's basename, and Gradle emits
  // `app-release.apk` for every React Native app. Renaming the build output is
  // the only thing that decides what a user ends up with in Downloads.
  it('renames the Gradle output between the build and the first publish', () => {
    const names = steps().map((step) => step.name)
    const build = names.indexOf('Build Android release APK')
    const rename = names.indexOf(RENAME_STEP)
    const upload = names.indexOf('Upload APK artifact')

    expect(build).toBeGreaterThanOrEqual(0)
    expect(rename).toBeGreaterThan(build)
    expect(upload).toBeGreaterThan(rename)
    expect(stepNamed(RENAME_STEP).run).toContain(`mv ${GRADLE_APK_NAME} ${ORCA_APK_NAME}`)
  })

  // Why not a glob: `*.apk` keeps passing while publishing whatever Gradle
  // emitted, so a rename that silently stopped running would ship the generic
  // name again with every check still green.
  it('publishes the renamed APK by exact path rather than a glob', () => {
    const published = [
      stepNamed('Upload APK artifact').with.path,
      stepNamed('Create GitHub Release').run
    ]

    for (const reference of published) {
      expect(reference).toContain(ORCA_APK_NAME)
      expect(reference).not.toContain('*.apk')
    }
  })

  // The rename is the one legitimate mention of the Gradle name. Anywhere else
  // is a path left pointing at a file that no longer exists by the time it runs.
  it('leaves no other step referring to the Gradle output name', () => {
    const bareGradleName = /(?<!orca-)app-release\.apk/

    for (const step of steps().filter((step) => step.name !== RENAME_STEP)) {
      expect(JSON.stringify(step)).not.toMatch(bareGradleName)
    }
  })
})
