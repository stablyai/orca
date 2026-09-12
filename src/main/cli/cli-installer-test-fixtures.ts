import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function makeFixture(): Promise<{
  root: string
  userDataPath: string
  appPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cli-installer-'))
  const userDataPath = join(root, 'userData')
  const appPath = join(root, 'app')
  const cliEntryPath = join(appPath, 'out', 'cli', 'index.js')
  await mkdir(join(appPath, 'out', 'cli'), { recursive: true })
  await writeFile(cliEntryPath, 'console.log("orca")\n', 'utf8')
  return { root, userDataPath, appPath }
}

export async function createPackagedMacLauncher(root: string): Promise<string> {
  const resourcesPath = join(root, 'resources')
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(join(resourcesPath, 'bin', 'orca'), '#!/usr/bin/env bash\necho orca\n', {
    encoding: 'utf8',
    mode: 0o755
  })
  return resourcesPath
}
