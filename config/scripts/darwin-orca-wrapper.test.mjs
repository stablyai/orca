import { copyFile, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const WRAPPER_SOURCE = join(REPO_ROOT, 'resources', 'darwin', 'bin', 'orca')
const describeDarwin = process.platform === 'darwin' ? describe : describe.skip
const fixtureRoots = []

const plist = (executable) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${
  executable === undefined ? '' : `<key>CFBundleExecutable</key><string>${executable}</string>`
}</dict></plist>
`

const createFixture = async ({ executable, marker }) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-darwin-wrapper-'))
  fixtureRoots.push(root)
  const app = join(root, 'Fixture.app')
  const wrapper = join(app, 'Contents', 'Resources', 'bin', 'orca')
  const cli = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js')
  await mkdir(dirname(wrapper), { recursive: true })
  await mkdir(dirname(cli), { recursive: true })
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await copyFile(WRAPPER_SOURCE, wrapper)
  await chmod(wrapper, 0o755)
  await writeFile(join(app, 'Contents', 'Info.plist'), plist(executable))
  await writeFile(cli, '')
  if (executable !== undefined) {
    const binary = join(app, 'Contents', 'MacOS', executable)
    await writeFile(binary, `#!/bin/sh\nprintf 'marker=${marker}\\ncli=%s\\narg=%s\\n' "$1" "$2"\n`)
    await chmod(binary, 0o755)
  }
  return { app, cli, wrapper }
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describeDarwin('darwin Orca CLI wrapper', () => {
  it.each([
    ['Orca', 'stable'],
    ['Orca Beta', 'beta']
  ])('launches the CFBundleExecutable %s', async (executable, marker) => {
    const { cli, wrapper } = await createFixture({ executable, marker })
    const expectedCli = await realpath(cli)
    const result = spawnSync(wrapper, ['probe'], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`marker=${marker}\ncli=${expectedCli}\narg=probe\n`)
  })

  it('fails before launch when CFBundleExecutable is missing', async () => {
    const { wrapper } = await createFixture({ executable: undefined, marker: 'unused' })
    const result = spawnSync(wrapper, ['probe'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unable to read CFBundleExecutable')
  })
})
