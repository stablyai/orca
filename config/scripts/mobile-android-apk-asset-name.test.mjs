import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const ORCA_APK_NAME = 'orca-app-release.apk'
const GRADLE_APK_NAME = 'app-release.apk'
const RENAME_STEP = 'Name the release APK for Orca'
// Gradle's own output directory. The rename writes here and every publish reads
// from here, so pinning it once is what keeps those two ends pointing at the
// same file.
const APK_OUTPUT_DIR = 'android/app/build/outputs/apk/release'
const ORCA_APK_PATH = `${APK_OUTPUT_DIR}/${ORCA_APK_NAME}`

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

    const run = stepNamed(RENAME_STEP).run
    const lines = run.split('\n').map((line) => line.trim())
    const cdLine = lines.indexOf(`cd ${APK_OUTPUT_DIR}`)
    const mvLine = lines.indexOf(`mv ${GRADLE_APK_NAME} ${ORCA_APK_NAME}`)

    expect(cdLine).toBeGreaterThanOrEqual(0)
    expect(mvLine).toBeGreaterThan(cdLine)
  })

  // `upload-artifact` resolves `path` from the workspace root, while `run` steps
  // inherit the job's `mobile` working directory. Both spellings of the one file
  // are pinned so a future edit cannot "correct" either into the other, and so a
  // publish cannot drift to a directory the rename never wrote to.
  it('publishes the renamed APK from the directory the rename wrote it to', () => {
    expect(stepNamed('Upload APK artifact').with.path).toBe(`mobile/${ORCA_APK_PATH}`)
  })

  // Why the count: the step publishes through `gh release upload` for a tag that
  // already exists and `gh release create` for one that does not. Asserting the
  // path appears twice catches a branch that kept a glob or was left behind.
  it('publishes the same exact path from both release branches', () => {
    const run = stepNamed('Create GitHub Release').run

    expect(run.split(ORCA_APK_PATH).length - 1).toBe(2)
    expect(run).toContain('gh release upload')
    expect(run).toContain('gh release create')
    expect(run).not.toContain('*.apk')
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
