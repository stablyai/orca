import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_BUN_RUNTIME_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return createHash('sha256').update(contents).digest('hex')
}

export async function writeOrcadTemplateTestFixture(resourcesDir) {
  const templateDir = join(resourcesDir, 'orcad-template')
  const commonFilenames = orcadArtifactFilenames().filter(
    (filename) =>
      filename !== ORCAD_BUN_RUNTIME_FILENAME &&
      filename !== ORCAD_BUILD_TARGET_FILENAME &&
      !filename.endsWith('watcher.node')
  )
  const commonSha256 = {}
  for (const filename of commonFilenames) {
    commonSha256[filename] = await write(
      join(templateDir, ...filename.split('/')),
      Buffer.from(`common:${filename}`)
    )
  }
  const targets = {}
  for (const target of ORCAD_BUN_TARGETS) {
    const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
    targets[target] = {
      targetSha256: await write(join(targetDir, ORCAD_BUILD_TARGET_FILENAME), `${target}\n`),
      watcherSha256: await write(join(targetDir, 'watcher.node'), `watcher:${target}`)
    }
  }
  const browserName = 'agent-browser-linux-x64'
  targets['linux-x64-glibc'] = {
    ...targets['linux-x64-glibc'],
    browserName,
    browserSha256: await write(
      join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, 'linux-x64-glibc', browserName),
      'browser'
    )
  }
  await writeFile(
    join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({ schemaVersion: 2, commonSha256, targets })
  )
  return templateDir
}
